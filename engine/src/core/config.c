#include "config.h"
#include "log.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define CONFIG_FILE "config.yaml"
#define MAX_LINE 8192

static void trim(char* str) {
    size_t len = strlen(str);
    while (len > 0 && (str[len - 1] == '\n' || str[len - 1] == '\r' ||
                       str[len - 1] == ' '  || str[len - 1] == '\t')) {
        str[--len] = '\0';
    }
    size_t start = 0;
    while (str[start] == ' ' || str[start] == '\t') start++;
    if (start > 0) memmove(str, str + start, len - start + 1);
}

static void strip_quotes(char* str) {
    size_t len = strlen(str);
    if (len >= 2 && ((str[0] == '"' && str[len - 1] == '"') ||
                     (str[0] == '\'' && str[len - 1] == '\''))) {
        memmove(str, str + 1, len - 2);
        str[len - 2] = '\0';
    }
}

static void parse_serial_ports(nexterm_config_t* cfg, const char* value) {
    cfg->serial_port_count = 0;

    char buf[MAX_LINE];
    snprintf(buf, sizeof(buf), "%s", value);

    char* saveptr = NULL;
    for (char* tok = strtok_r(buf, ",", &saveptr); tok;
         tok = strtok_r(NULL, ",", &saveptr)) {
        trim(tok);
        strip_quotes(tok);
        if (tok[0] == '\0') continue;

        if (cfg->serial_port_count >= NEXTERM_MAX_SERIAL_PORTS) {
            LOG_WARN("Too many serial ports configured, ignoring: %s", tok);
            continue;
        }

        snprintf(cfg->serial_ports[cfg->serial_port_count],
                 NEXTERM_SERIAL_PORT_PATH_LEN, "%s", tok);
        cfg->serial_port_count++;
    }
}

static int parse_config_file(nexterm_config_t* cfg) {
    FILE* f = fopen(CONFIG_FILE, "r");
    if (!f) return -1;

    char line[MAX_LINE];
    while (fgets(line, sizeof(line), f)) {
        if (strlen(line) == MAX_LINE - 1 && line[MAX_LINE - 2] != '\n') {
            LOG_WARN("Config line exceeds %d characters and was truncated", MAX_LINE - 1);
            int c;
            while ((c = fgetc(f)) != EOF && c != '\n');
        }
        trim(line);
        if (line[0] == '\0' || line[0] == '#') continue;

        char* colon = strchr(line, ':');
        if (!colon) continue;

        *colon = '\0';
        char* key = line;
        char* value = colon + 1;

        while (*value == ' ' || *value == '\t') value++;
        trim(key);
        strip_quotes(value);

        if (strcmp(key, "registration_token") == 0) {
            snprintf(cfg->registration_token, sizeof(cfg->registration_token), "%s", value);
        } else if (strcmp(key, "server_host") == 0) {
            snprintf(cfg->server_host, sizeof(cfg->server_host), "%s", value);
        } else if (strcmp(key, "server_port") == 0) {
            char* endptr;
            long port = strtol(value, &endptr, 10);
            if (*endptr == '\0' && port > 0 && port <= 65535)
                cfg->server_port = (uint16_t)port;
        } else if (strcmp(key, "tls") == 0) {
            cfg->tls = (strcmp(value, "true") == 0 || strcmp(value, "1") == 0);
        } else if (strcmp(key, "ca_cert_path") == 0) {
            snprintf(cfg->ca_cert_path, sizeof(cfg->ca_cert_path), "%s", value);
        } else if (strcmp(key, "tls_skip_verify") == 0) {
            cfg->tls_skip_verify = (strcmp(value, "true") == 0 || strcmp(value, "1") == 0);
        } else if (strcmp(key, "serial_ports") == 0) {
            parse_serial_ports(cfg, value);
        }
    }

    fclose(f);
    return 0;
}

static int write_default_config(const nexterm_config_t* cfg) {
    FILE* f = fopen(CONFIG_FILE, "w");
    if (!f) {
        LOG_ERROR("Failed to create %s: %s", CONFIG_FILE, strerror(errno));
        return -1;
    }

    if (fchmod(fileno(f), S_IRUSR | S_IWUSR) != 0)
        LOG_WARN("Could not restrict permissions on %s", CONFIG_FILE);

    fprintf(f, "registration_token: \"%s\"\n", cfg->registration_token);
    fprintf(f, "server_host: \"%s\"\n", cfg->server_host);
    fprintf(f, "server_port: %u\n", cfg->server_port);
    fprintf(f, "tls: %s\n", cfg->tls ? "true" : "false");
    fprintf(f, "ca_cert_path: \"%s\"\n", cfg->ca_cert_path);
    fprintf(f, "tls_skip_verify: %s\n", cfg->tls_skip_verify ? "true" : "false");
    fprintf(f, "# Comma-separated list of serial devices that may be opened remotely.\n");
    fprintf(f, "# Empty means serial console access is disabled.\n");
    fprintf(f, "serial_ports: \"\"\n");

    fclose(f);
    LOG_INFO("Created default config file: %s", CONFIG_FILE);
    return 0;
}

static nexterm_config_t g_config;

const nexterm_config_t* nexterm_config_get(void) {
    return &g_config;
}

bool nexterm_config_serial_port_allowed(const char* device) {
    if (!device || device[0] == '\0') return false;
    for (int i = 0; i < g_config.serial_port_count; i++) {
        if (strcmp(g_config.serial_ports[i], device) == 0)
            return true;
    }
    return false;
}

const nexterm_config_t* nexterm_config_load(void) {
    nexterm_config_t* cfg = &g_config;
    memset(cfg, 0, sizeof(*cfg));
    snprintf(cfg->server_host, sizeof(cfg->server_host), "%s", "127.0.0.1");
    cfg->server_port = 7800;
    cfg->tls = false;
    cfg->registration_token[0] = '\0';
    cfg->ca_cert_path[0] = '\0';
    cfg->tls_skip_verify = false;

    if (parse_config_file(cfg) != 0) {
        LOG_INFO("No config file found, creating default %s", CONFIG_FILE);
        if (write_default_config(cfg) != 0)
            LOG_WARN("Could not write default config file");
    }

    const char* env_token = getenv("REGISTRATION_TOKEN");
    if (env_token && env_token[0] != '\0') {
        snprintf(cfg->registration_token, sizeof(cfg->registration_token), "%s", env_token);
        LOG_INFO("Using REGISTRATION_TOKEN from environment variable");
    }

    const char* env_ca = getenv("CONTROL_PLANE_CA_CERT");
    if (env_ca && env_ca[0] != '\0')
        snprintf(cfg->ca_cert_path, sizeof(cfg->ca_cert_path), "%s", env_ca);

    const char* env_skip = getenv("TLS_SKIP_VERIFY");
    if (env_skip && (strcmp(env_skip, "true") == 0 || strcmp(env_skip, "1") == 0))
        cfg->tls_skip_verify = true;

    const char* env_serial = getenv("SERIAL_PORTS");
    if (env_serial && env_serial[0] != '\0') {
        parse_serial_ports(cfg, env_serial);
        LOG_INFO("Using SERIAL_PORTS from environment variable");
    }

    if (cfg->serial_port_count > 0)
        LOG_INFO("Serial console access enabled for %d port(s)", cfg->serial_port_count);

    return cfg;
}
