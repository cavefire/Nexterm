#include "serial.h"
#include "config.h"
#include "control_plane.h"
#include "io.h"
#include "log.h"
#include "session.h"

extern nexterm_session_manager_t g_session_manager;

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#define SERIAL_BUF_SIZE 16384

typedef struct {
    nexterm_session_t* session;
    nexterm_control_plane_t* cp;
} serial_thread_args_t;

static speed_t baud_to_speed(long baud) {
    switch (baud) {
        case 300:    return B300;
        case 600:    return B600;
        case 1200:   return B1200;
        case 2400:   return B2400;
        case 4800:   return B4800;
        case 9600:   return B9600;
        case 19200:  return B19200;
        case 38400:  return B38400;
        case 57600:  return B57600;
        case 115200: return B115200;
        case 230400: return B230400;
#ifdef B460800
        case 460800: return B460800;
#endif
#ifdef B921600
        case 921600: return B921600;
#endif
        default:     return 0;
    }
}

static long serial_param_long(const nexterm_session_t* session,
                              const char* key, long fallback) {
    const char* value = nexterm_session_get_param(session, key);
    if (!value || value[0] == '\0') return fallback;

    char* endptr;
    long parsed = strtol(value, &endptr, 10);
    if (*endptr != '\0') return fallback;
    return parsed;
}

static int serial_configure(nexterm_session_t* session, int fd,
                            char* errbuf, size_t errbuf_len) {
    struct termios tio;
    if (tcgetattr(fd, &tio) != 0) {
        snprintf(errbuf, errbuf_len, "Failed to read terminal attributes: %s",
                 strerror(errno));
        return -1;
    }

    cfmakeraw(&tio);
    tio.c_cflag |= CLOCAL | CREAD;
    tio.c_cc[VMIN] = 1;
    tio.c_cc[VTIME] = 0;

    long baud = serial_param_long(session, "baudRate", 115200);
    speed_t speed = baud_to_speed(baud);
    if (speed == 0) {
        snprintf(errbuf, errbuf_len, "Unsupported baud rate: %ld", baud);
        return -1;
    }
    cfsetispeed(&tio, speed);
    cfsetospeed(&tio, speed);

    long data_bits = serial_param_long(session, "dataBits", 8);
    tio.c_cflag &= ~CSIZE;
    switch (data_bits) {
        case 5: tio.c_cflag |= CS5; break;
        case 6: tio.c_cflag |= CS6; break;
        case 7: tio.c_cflag |= CS7; break;
        case 8: tio.c_cflag |= CS8; break;
        default:
            snprintf(errbuf, errbuf_len, "Unsupported data bits: %ld", data_bits);
            return -1;
    }

    const char* parity = nexterm_session_get_param(session, "parity");
    if (!parity || parity[0] == '\0' || strcmp(parity, "none") == 0) {
        tio.c_cflag &= ~PARENB;
    } else if (strcmp(parity, "even") == 0) {
        tio.c_cflag |= PARENB;
        tio.c_cflag &= ~PARODD;
    } else if (strcmp(parity, "odd") == 0) {
        tio.c_cflag |= PARENB | PARODD;
    } else {
        snprintf(errbuf, errbuf_len, "Unsupported parity: %s", parity);
        return -1;
    }

    long stop_bits = serial_param_long(session, "stopBits", 1);
    if (stop_bits == 1)
        tio.c_cflag &= ~CSTOPB;
    else if (stop_bits == 2)
        tio.c_cflag |= CSTOPB;
    else {
        snprintf(errbuf, errbuf_len, "Unsupported stop bits: %ld", stop_bits);
        return -1;
    }

    if (tcsetattr(fd, TCSANOW, &tio) != 0) {
        snprintf(errbuf, errbuf_len, "Failed to apply terminal attributes: %s",
                 strerror(errno));
        return -1;
    }

    tcflush(fd, TCIOFLUSH);
    return 0;
}

static int serial_open(nexterm_session_t* session,
                       char* errbuf, size_t errbuf_len) {
    const char* device = session->host;

    if (!nexterm_config_serial_port_allowed(device)) {
        snprintf(errbuf, errbuf_len,
                 "Serial port not allowed by engine configuration: %s",
                 device ? device : "(none)");
        return -1;
    }

    if (nexterm_sm_serial_in_use(&g_session_manager, session, device)) {
        snprintf(errbuf, errbuf_len,
                 "Serial port is already in use: %s", device);
        return -1;
    }

    int fd = open(device, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) {
        snprintf(errbuf, errbuf_len, "Failed to open %s: %s",
                 device, strerror(errno));
        return -1;
    }

    if (ioctl(fd, TIOCEXCL) != 0)
        LOG_WARN("Serial session %s: could not get exclusive access to %s: %s",
                 session->session_id, device, strerror(errno));

    if (serial_configure(session, fd, errbuf, errbuf_len) != 0) {
        close(fd);
        return -1;
    }

    int flags = fcntl(fd, F_GETFL);
    if (flags >= 0)
        fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);

    return fd;
}

static bool serial_bridge_poll(int data_fd, int serial_fd) {
    uint8_t buf[SERIAL_BUF_SIZE];
    struct pollfd fds[2] = {
        { .fd = data_fd,   .events = POLLIN },
        { .fd = serial_fd, .events = POLLIN },
    };

    int ret = poll(fds, 2, 200);
    if (ret < 0)
        return errno == EINTR;
    if (ret == 0)
        return true;

    if (fds[0].revents & POLLIN) {
        ssize_t n = read(data_fd, buf, sizeof(buf));
        if (n <= 0) return false;
        if (nexterm_write_exact(serial_fd, buf, (size_t)n) != 0) return false;
    }

    if (fds[1].revents & POLLIN) {
        ssize_t n = read(serial_fd, buf, sizeof(buf));
        if (n <= 0) return false;
        if (nexterm_write_exact(data_fd, buf, (size_t)n) != 0) return false;
    }

    if (fds[0].revents & (POLLERR | POLLHUP))
        return false;
    if (fds[1].revents & (POLLERR | POLLHUP))
        return false;

    return true;
}

static void* serial_session_thread(void* arg) {
    serial_thread_args_t* args = (serial_thread_args_t*)arg;
    nexterm_session_t* session = args->session;
    nexterm_control_plane_t* cp = args->cp;
    int data_fd = -1;
    int serial_fd = -1;
    char errbuf[512];

    session->state = SESSION_STATE_CONNECTING;

    LOG_INFO("Serial session %s: opening %s",
             session->session_id, session->host);

    serial_fd = serial_open(session, errbuf, sizeof(errbuf));
    if (serial_fd < 0) {
        LOG_ERROR("Serial session %s: %s", session->session_id, errbuf);
        nexterm_cp_send_session_result(cp, session->session_id, false,
                                       errbuf, NULL);
        goto cleanup;
    }

    data_fd = nexterm_cp_open_data_connection(cp, session->session_id);
    if (data_fd < 0) {
        nexterm_cp_send_session_result(cp, session->session_id, false,
                                       "Failed to open data connection", NULL);
        goto cleanup;
    }

    session->serial_fd = serial_fd;
    session->state = SESSION_STATE_ACTIVE;
    nexterm_cp_send_session_result(cp, session->session_id, true, NULL, NULL);

    LOG_INFO("Serial session %s active (device=%s)",
             session->session_id, session->host);

    while (session->state == SESSION_STATE_ACTIVE
            && serial_bridge_poll(data_fd, serial_fd));

    LOG_INFO("Serial session %s ending", session->session_id);

cleanup:
    session->serial_fd = -1;

    if (serial_fd >= 0)
        close(serial_fd);
    if (data_fd >= 0)
        close(data_fd);

    char sid[MAX_SESSION_ID_LEN];
    snprintf(sid, sizeof(sid), "%s", session->session_id);
    nexterm_cp_send_session_closed(cp, sid, "session ended");
    nexterm_sm_finish(&g_session_manager, sid);

    free(args);
    return NULL;
}

int nexterm_serial_start(nexterm_session_t* session,
                         nexterm_control_plane_t* cp) {
    serial_thread_args_t* args = calloc(1, sizeof(serial_thread_args_t));
    if (!args) return -1;

    args->session = session;
    args->cp = cp;

    if (pthread_create(&session->thread, NULL, serial_session_thread, args) != 0) {
        LOG_ERROR("Failed to create serial thread for session %s",
                  session->session_id);
        free(args);
        return -1;
    }

    session->thread_active = true;
    pthread_detach(session->thread);
    return 0;
}
