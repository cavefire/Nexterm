#ifndef NEXTERM_SERIAL_H
#define NEXTERM_SERIAL_H

#include "session.h"

struct nexterm_control_plane;

int nexterm_serial_start(nexterm_session_t* session,
                         struct nexterm_control_plane* cp);

#endif
