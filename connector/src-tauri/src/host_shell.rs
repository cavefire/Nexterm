use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use std::io::{Read, Write};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

// Exposes this PC's shell to the user's own Nexterm account. When enabled, a
// persistent "provider" WebSocket is held open to the server (authenticated by the
// user's session token)

#[derive(Clone)]
pub struct HostShellConfig {
    pub server_url: String,
    pub token: String,
    pub device_id: String,
    pub device_name: String,
}

pub struct HostShellManager {
    cancel: Mutex<Option<broadcast::Sender<()>>>,
}

impl HostShellManager {
    pub fn new() -> Self {
        Self { cancel: Mutex::new(None) }
    }

    pub async fn start(&self, config: HostShellConfig) -> Result<(), String> {
        self.stop().await;

        let (cancel_tx, _) = broadcast::channel::<()>(1);
        *self.cancel.lock().await = Some(cancel_tx.clone());

        tokio::spawn(async move {
            run_provider(config, cancel_tx.subscribe()).await;
        });
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(tx) = self.cancel.lock().await.take() {
            let _ = tx.send(());
        }
    }

    pub async fn is_running(&self) -> bool {
        self.cancel.lock().await.is_some()
    }
}

fn ws_base(server_url: &str) -> Result<String, String> {
    let base = server_url.trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("https://") {
        Ok(format!("wss://{}", rest))
    } else if let Some(rest) = base.strip_prefix("http://") {
        Ok(format!("ws://{}", rest))
    } else if base.starts_with("ws://") || base.starts_with("wss://") {
        Ok(base.to_string())
    } else {
        Err("Invalid server URL".to_string())
    }
}

fn encode(s: &str) -> String {
    crate::urlencoding::encode(s)
}

async fn run_provider(config: HostShellConfig, mut cancel: broadcast::Receiver<()>) {
    loop {
        if let Err(e) = provider_session(&config, &mut cancel).await {
            eprintln!("Host shell provider error: {}", e);
        }

        tokio::select! {
            _ = cancel.recv() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
        }
    }
}

async fn provider_session(
    config: &HostShellConfig,
    cancel: &mut broadcast::Receiver<()>,
) -> Result<(), String> {
    let os = os_info::get().os_type().to_string();
    let url = format!(
        "{}/api/ws/host-shell/provider?sessionToken={}&deviceId={}&name={}&os={}",
        ws_base(&config.server_url)?,
        encode(&config.token),
        encode(&config.device_id),
        encode(&config.device_name),
        encode(&os),
    );

    let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("Provider connection failed: {}", e))?;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    let mut ping = tokio::time::interval(std::time::Duration::from_secs(30));

    loop {
        tokio::select! {
            _ = cancel.recv() => {
                let _ = ws_write.close().await;
                return Ok(());
            }
            _ = ping.tick() => {
                if ws_write.send(Message::Text("{\"type\":\"ping\"}".into())).await.is_err() {
                    return Ok(());
                }
            }
            msg = ws_read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => handle_control(&text, config),
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(e)) => return Err(format!("Provider socket error: {}", e)),
                    _ => {}
                }
            }
        }
    }
}

#[derive(Deserialize)]
struct ControlMessage {
    r#type: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

fn handle_control(text: &str, config: &HostShellConfig) {
    let Ok(msg) = serde_json::from_str::<ControlMessage>(text) else { return };
    if msg.r#type == "open" {
        if let Some(session_id) = msg.session_id {
            let config = config.clone();
            tokio::spawn(async move {
                if let Err(e) = run_shell_session(config, session_id).await {
                    eprintln!("Host shell session error: {}", e);
                }
            });
        }
    }
}

#[derive(Deserialize)]
struct ResizeMessage {
    r#type: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn run_shell_session(config: HostShellConfig, session_id: String) -> Result<(), String> {
    let url = format!(
        "{}/api/ws/host-shell/data?sessionToken={}&sessionId={}",
        ws_base(&config.server_url)?,
        encode(&config.token),
        encode(&session_id),
    );

    let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("Data connection failed: {}", e))?;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut child = pair
        .slave
        .spawn_command(CommandBuilder::new_default_prog())
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => if out_tx.send(buf[..n].to_vec()).is_err() { break },
            }
        }
    });

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Some(data) = in_rx.blocking_recv() {
            if writer.write_all(&data).is_err() { break }
            let _ = writer.flush();
        }
    });

    let result = loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(data) => if ws_write.send(Message::Binary(data)).await.is_err() { break Ok(()) },
                None => break Ok(()),
            },
            msg = ws_read.next() => match msg {
                Some(Ok(Message::Binary(data))) => { let _ = in_tx.send(data); }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(r) = serde_json::from_str::<ResizeMessage>(&text) {
                        if r.r#type == "resize" {
                            let _ = master.resize(PtySize {
                                rows: r.rows.unwrap_or(24),
                                cols: r.cols.unwrap_or(80),
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Err(e)) => break Err(format!("Data socket error: {}", e)),
                _ => {}
            },
        }
    };

    let _ = child.kill();
    let _ = ws_write.close().await;
    result
}
