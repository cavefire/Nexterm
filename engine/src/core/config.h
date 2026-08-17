#ifndef NEXTERM_CONFIG_H
#define NEXTERM_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

#define NEXTERM_MAX_SERIAL_PORTS 32
#define NEXTERM_SERIAL_PORT_PATH_LEN 256

typedef struct nexterm_config {
    char registration_token[256];
    char server_host[256];
    uint16_t server_port;
    bool tls;
    char ca_cert_path[512];
    bool tls_skip_verify;
    char serial_ports[NEXTERM_MAX_SERIAL_PORTS][NEXTERM_SERIAL_PORT_PATH_LEN];
    int serial_port_count;
} nexterm_config_t;

const nexterm_config_t* nexterm_config_load(void);

const nexterm_config_t* nexterm_config_get(void);

bool nexterm_config_serial_port_allowed(const char* device);

#endif
