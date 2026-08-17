use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::host_fs::resolve_path;
use crate::host_shell::{ws_base, HostShellConfig};

const READ_CHUNK: usize = 262_144;

#[derive(Deserialize)]
struct FsRequest {
    id: u32,
    op: String,
    path: Option<String>,
    #[serde(rename = "newPath")]
    new_path: Option<String>,
    mode: Option<u32>,
    recursive: Option<bool>,
    #[serde(rename = "searchPath")]
    search_path: Option<String>,
    #[serde(rename = "maxResults")]
    max_results: Option<usize>,
}

fn ok_msg(id: u32, data: Value) -> Message {
    Message::Text(json!({ "id": id, "ok": true, "data": data }).to_string().into())
}

fn fail_msg(id: u32, err: impl ToString) -> Message {
    Message::Text(json!({ "id": id, "ok": false, "error": err.to_string() }).to_string().into())
}

fn done_msg(id: u32) -> Message {
    Message::Text(json!({ "id": id, "done": true }).to_string().into())
}

fn resolve(path: &Option<String>) -> Result<Option<PathBuf>, String> {
    let p = path.as_deref().ok_or("missing path")?;
    resolve_path(p).map_err(|e| e.into_message())
}

fn resolve_real(path: &Option<String>) -> Result<PathBuf, String> {
    resolve(path)?.ok_or_else(|| "the root is read-only".to_string())
}

fn secs(t: std::io::Result<SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mode_of(md: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        if md.is_dir() { 0o755 } else { 0o644 }
    }
}

fn stat_value(md: &Metadata) -> Value {
    #[cfg(unix)]
    let (uid, gid) = {
        use std::os::unix::fs::MetadataExt;
        (md.uid(), md.gid())
    };
    #[cfg(not(unix))]
    let (uid, gid) = (0u32, 0u32);

    json!({
        "size": md.len(),
        "mode": mode_of(md),
        "uid": uid,
        "gid": gid,
        "atime": secs(md.accessed()),
        "mtime": secs(md.modified()),
        "owner": "",
        "group": "",
        "isDir": md.is_dir(),
    })
}

fn list_entry(name: String, md: &Metadata, is_symlink: bool) -> Value {
    json!({
        "name": name,
        "type": if md.is_dir() { "folder" } else { "file" },
        "isSymlink": is_symlink,
        "last_modified": secs(md.modified()),
        "size": md.len(),
        "mode": mode_of(md),
    })
}

#[cfg(windows)]
fn root_entries() -> Vec<Value> {
    crate::host_fs::list_drive_letters()
        .into_iter()
        .map(|letter| {
            json!({
                "name": letter.to_string(),
                "type": "folder",
                "isSymlink": false,
                "last_modified": 0,
                "size": 0,
                "mode": 0o755,
            })
        })
        .collect()
}

#[cfg(not(windows))]
fn root_entries() -> Vec<Value> {
    Vec::new()
}

#[cfg(windows)]
fn to_virtual(real: &Path) -> String {
    let s = real.to_string_lossy();
    let s = s.trim_start_matches(r"\\?\");
    format!("/{}", s.replace('\\', "/").replace(':', ""))
}

#[cfg(not(windows))]
fn to_virtual(real: &Path) -> String {
    real.to_string_lossy().into_owned()
}

fn op_list(path: &Option<String>) -> Result<Value, String> {
    let real = match resolve(path)? {
        None => return Ok(Value::Array(root_entries())),
        Some(p) => p,
    };
    let mut files = Vec::new();
    for ent in std::fs::read_dir(&real).map_err(|e| e.to_string())?.flatten() {
        let Ok(ft) = ent.file_type() else { continue };
        let is_symlink = ft.is_symlink();
        let md = if is_symlink { std::fs::metadata(ent.path()) } else { ent.metadata() };
        let Ok(md) = md else { continue };
        files.push(list_entry(ent.file_name().to_string_lossy().into_owned(), &md, is_symlink));
    }
    Ok(Value::Array(files))
}

fn op_stat(path: &Option<String>) -> Result<Value, String> {
    let real = match resolve(path)? {
        None => {
            return Ok(json!({
                "size": 0, "mode": 0o755, "uid": 0, "gid": 0,
                "atime": 0, "mtime": 0, "owner": "", "group": "", "isDir": true,
            }))
        }
        Some(p) => p,
    };
    let md = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    Ok(stat_value(&md))
}

fn op_realpath(path: &Option<String>) -> Result<Value, String> {
    let real = resolve_real(path)?;
    let canonical = std::fs::canonicalize(&real).map_err(|e| e.to_string())?;
    let is_dir = std::fs::metadata(&canonical).map(|m| m.is_dir()).unwrap_or(false);
    Ok(json!({ "path": to_virtual(&canonical), "isDirectory": is_dir }))
}

fn op_search_dirs(search_path: &Option<String>, max_results: usize) -> Result<Value, String> {
    let sp = search_path.as_deref().ok_or("missing searchPath")?;
    let (parent, prefix) = match sp.rfind('/') {
        Some(i) => (&sp[..=i], &sp[i + 1..]),
        None => ("/", sp),
    };
    let prefix_lower = prefix.to_lowercase();

    let names: Vec<String> = match resolve(&Some(parent.to_string()))? {
        None => root_entries()
            .into_iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect(),
        Some(real) => {
            let mut names = Vec::new();
            for ent in std::fs::read_dir(&real).map_err(|e| e.to_string())?.flatten() {
                let is_dir = ent
                    .file_type()
                    .map(|ft| ft.is_dir() || (ft.is_symlink() && ent.path().is_dir()))
                    .unwrap_or(false);
                if is_dir {
                    names.push(ent.file_name().to_string_lossy().into_owned());
                }
            }
            names
        }
    };

    let dirs: Vec<String> = names
        .into_iter()
        .filter(|n| n.to_lowercase().starts_with(&prefix_lower))
        .take(max_results)
        .map(|n| format!("{}{}", parent, n))
        .collect();
    Ok(json!(dirs))
}

fn dispatch_sync(req: &FsRequest) -> Result<Value, String> {
    match req.op.as_str() {
        "list" => op_list(&req.path),
        "stat" => op_stat(&req.path),
        "realpath" => op_realpath(&req.path),
        "searchDirs" => op_search_dirs(&req.search_path, req.max_results.unwrap_or(20)),
        "mkdir" => {
            std::fs::create_dir(resolve_real(&req.path)?).map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "unlink" => {
            let real = resolve_real(&req.path)?;
            match std::fs::remove_file(&real) {
                Err(_) if real.is_dir() => std::fs::remove_dir(&real).map_err(|e| e.to_string())?,
                other => other.map_err(|e| e.to_string())?,
            }
            Ok(json!({}))
        }
        "rmdir" => {
            let real = resolve_real(&req.path)?;
            if req.recursive.unwrap_or(false) {
                std::fs::remove_dir_all(&real).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_dir(&real).map_err(|e| e.to_string())?;
            }
            Ok(json!({}))
        }
        "rename" => {
            let old = resolve_real(&req.path)?;
            let new = resolve_real(&req.new_path)?;
            std::fs::rename(&old, &new).map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "chmod" => {
            let real = resolve_real(&req.path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = req.mode.ok_or("missing mode")?;
                std::fs::set_permissions(&real, std::fs::Permissions::from_mode(mode))
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            let _ = &real;
            Ok(json!({}))
        }
        other => Err(format!("unknown op: {}", other)),
    }
}

fn spawn_read(id: u32, path: Option<String>, out: mpsc::Sender<Message>) {
    tokio::task::spawn_blocking(move || {
        let real = match resolve(&path).and_then(|r| r.ok_or_else(|| "not a file".to_string())) {
            Ok(p) => p,
            Err(e) => {
                let _ = out.blocking_send(fail_msg(id, e));
                return;
            }
        };
        let mut file = match File::open(&real) {
            Ok(f) => f,
            Err(e) => {
                let _ = out.blocking_send(fail_msg(id, e));
                return;
            }
        };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        if out.blocking_send(ok_msg(id, json!({ "size": size }))).is_err() {
            return;
        }

        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match file.read(&mut buf) {
                Ok(0) => {
                    let _ = out.blocking_send(done_msg(id));
                    return;
                }
                Ok(n) => {
                    let mut frame = Vec::with_capacity(4 + n);
                    frame.extend_from_slice(&id.to_be_bytes());
                    frame.extend_from_slice(&buf[..n]);
                    if out.blocking_send(Message::Binary(frame.into())).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = out.blocking_send(fail_msg(id, e));
                    return;
                }
            }
        }
    });
}

async fn handle_request(
    req: FsRequest,
    out: &mpsc::Sender<Message>,
    writes: &mut HashMap<u32, File>,
    failed_writes: &mut HashSet<u32>,
) {
    let id = req.id;
    match req.op.as_str() {
        "read" => spawn_read(id, req.path, out.clone()),
        "write-open" => {
            let result = resolve_real(&req.path)
                .and_then(|real| File::create(&real).map_err(|e| e.to_string()));
            let msg = match result {
                Ok(file) => {
                    writes.insert(id, file);
                    ok_msg(id, json!({}))
                }
                Err(e) => {
                    failed_writes.insert(id);
                    fail_msg(id, e)
                }
            };
            let _ = out.send(msg).await;
        }
        "write-close" => {
            let msg = if failed_writes.remove(&id) {
                fail_msg(id, "write failed")
            } else if let Some(mut file) = writes.remove(&id) {
                match file.flush() {
                    Ok(()) => ok_msg(id, json!({})),
                    Err(e) => fail_msg(id, e),
                }
            } else {
                fail_msg(id, "no open write for this id")
            };
            let _ = out.send(msg).await;
        }
        _ => {
            let result = tokio::task::spawn_blocking(move || dispatch_sync(&req))
                .await
                .unwrap_or_else(|e| Err(format!("task failed: {}", e)));
            let msg = match result {
                Ok(data) => ok_msg(id, data),
                Err(e) => fail_msg(id, e),
            };
            let _ = out.send(msg).await;
        }
    }
}

pub async fn run_fs_session(config: HostShellConfig, session_id: String) -> Result<(), String> {
    let url = format!(
        "{}/api/ws/host-shell/fs?sessionToken={}&sessionId={}",
        ws_base(&config.server_url)?,
        crate::urlencoding::encode(&config.token),
        crate::urlencoding::encode(&session_id),
    );

    let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("Fs connection failed: {}", e))?;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    let (out_tx, mut out_rx) = mpsc::channel::<Message>(16);
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_write.send(msg).await.is_err() {
                break;
            }
        }
        let _ = ws_write.close().await;
    });

    let _ = out_tx.send(Message::Text(json!({ "ready": true }).to_string().into())).await;

    let mut writes: HashMap<u32, File> = HashMap::new();
    let mut failed_writes: HashSet<u32> = HashSet::new();

    while let Some(msg) = ws_read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let Ok(req) = serde_json::from_str::<FsRequest>(&text) else { continue };
                handle_request(req, &out_tx, &mut writes, &mut failed_writes).await;
            }
            Ok(Message::Binary(data)) => {
                if data.len() < 4 {
                    continue;
                }
                let id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                if let Some(file) = writes.get_mut(&id) {
                    if let Err(e) = file.write_all(&data[4..]) {
                        writes.remove(&id);
                        failed_writes.insert(id);
                        let _ = out_tx.send(fail_msg(id, e)).await;
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    drop(out_tx);
    let _ = writer.await;
    Ok(())
}
