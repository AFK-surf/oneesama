#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void die(const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static Display *open_display(void) {
  Display *display = XOpenDisplay(NULL);
  if (!display) {
    die("cannot open DISPLAY");
  }
  return display;
}

static void require_xtest(Display *display) {
  int event_base = 0;
  int error_base = 0;
  int major = 0;
  int minor = 0;
  if (!XTestQueryExtension(display, &event_base, &error_base, &major, &minor)) {
    die("XTEST extension unavailable");
  }
}

static void pointer_position(Display *display, int *x, int *y) {
  Window root = DefaultRootWindow(display);
  Window root_return = 0;
  Window child_return = 0;
  int root_x = 0;
  int root_y = 0;
  int win_x = 0;
  int win_y = 0;
  unsigned int mask = 0;
  if (!XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y, &win_x, &win_y, &mask)) {
    die("cannot query pointer");
  }
  *x = root_x;
  *y = root_y;
}

static void fake_keycode(Display *display, KeyCode keycode, int is_press) {
  if (!keycode) {
    die("no keycode for keysym");
  }
  XTestFakeKeyEvent(display, keycode, is_press ? True : False, CurrentTime);
}

static void fake_keysym(Display *display, KeySym keysym, int shift) {
  KeyCode code = XKeysymToKeycode(display, keysym);
  if (!code) {
    die("no keycode for keysym");
  }

  KeyCode shift_code = XKeysymToKeycode(display, XK_Shift_L);
  if (shift) {
    fake_keycode(display, shift_code, 1);
  }
  fake_keycode(display, code, 1);
  fake_keycode(display, code, 0);
  if (shift) {
    fake_keycode(display, shift_code, 0);
  }
  XFlush(display);
}

static KeySym named_keysym(const char *name) {
  if (strcmp(name, "Escape") == 0 || strcmp(name, "Esc") == 0 || strcmp(name, "escape") == 0) {
    return XK_Escape;
  }
  if (strcmp(name, "Enter") == 0 || strcmp(name, "Return") == 0 || strcmp(name, "return") == 0) {
    return XK_Return;
  }
  if (strcmp(name, "Tab") == 0 || strcmp(name, "tab") == 0) {
    return XK_Tab;
  }
  if (strcmp(name, "Space") == 0 || strcmp(name, "space") == 0) {
    return XK_space;
  }
  return XStringToKeysym(name);
}

static KeySym ascii_keysym(char ch, int *shift) {
  *shift = 0;
  if (ch >= 'a' && ch <= 'z') {
    return XK_a + (ch - 'a');
  }
  if (ch >= 'A' && ch <= 'Z') {
    *shift = 1;
    return XK_a + (ch - 'A');
  }
  if (ch >= '0' && ch <= '9') {
    return XK_0 + (ch - '0');
  }
  switch (ch) {
    case ' ': return XK_space;
    case '.': return XK_period;
    case ',': return XK_comma;
    case '-': return XK_minus;
    case '_': *shift = 1; return XK_minus;
    case '/': return XK_slash;
    case ':': *shift = 1; return XK_semicolon;
    case ';': return XK_semicolon;
    case '\'': return XK_apostrophe;
    case '"': *shift = 1; return XK_apostrophe;
    case '@': *shift = 1; return XK_2;
    case '&': *shift = 1; return XK_7;
    case '(': *shift = 1; return XK_9;
    case ')': *shift = 1; return XK_0;
    default: return NoSymbol;
  }
}

static void send_hotkey(Display *display, const char *name) {
  if (strcmp(name, "ctrl+a") == 0 || strcmp(name, "Control+a") == 0 || strcmp(name, "ctrl+v") == 0 || strcmp(name, "Control+v") == 0) {
    KeyCode control = XKeysymToKeycode(display, XK_Control_L);
    KeyCode key = XKeysymToKeycode(display, (strstr(name, "+v") || strstr(name, "+V")) ? XK_v : XK_a);
    fake_keycode(display, control, 1);
    fake_keycode(display, key, 1);
    fake_keycode(display, key, 0);
    fake_keycode(display, control, 0);
    XFlush(display);
    return;
  }

  KeySym keysym = named_keysym(name);
  if (keysym == NoSymbol && strlen(name) == 1) {
    int shift = 0;
    keysym = ascii_keysym(name[0], &shift);
    if (keysym == NoSymbol) {
      die("unsupported key");
    }
    fake_keysym(display, keysym, shift);
    return;
  }
  if (keysym == NoSymbol) {
    die("unsupported key");
  }
  fake_keysym(display, keysym, 0);
}

static void send_text(Display *display, const char *text, int delay_ms) {
  for (const char *p = text; *p; p++) {
    int shift = 0;
    KeySym keysym = ascii_keysym(*p, &shift);
    if (keysym == NoSymbol) {
      die("unsupported text character");
    }
    fake_keysym(display, keysym, shift);
    if (delay_ms > 0) {
      usleep((useconds_t)delay_ms * 1000);
    }
  }
}

static void command_probe(Display *display, int json) {
  require_xtest(display);
  int x = 0;
  int y = 0;
  pointer_position(display, &x, &y);
  if (json) {
    printf("{\"xtest\":true,\"x\":%d,\"y\":%d}\n", x, y);
  } else {
    printf("X=%d\nY=%d\n", x, y);
  }
}

static void command_position(Display *display) {
  int x = 0;
  int y = 0;
  pointer_position(display, &x, &y);
  printf("X=%d\nY=%d\n", x, y);
}

static void command_move_click(Display *display, int argc, char **argv) {
  require_xtest(display);
  int button = 1;
  int hold_ms = 0;
  int pre_click_ms = 0;
  int saw_point = 0;

  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--button") == 0 && i + 1 < argc) {
      button = atoi(argv[++i]);
      continue;
    }
    if (strcmp(argv[i], "--hold-ms") == 0 && i + 1 < argc) {
      hold_ms = atoi(argv[++i]);
      continue;
    }
    if (strcmp(argv[i], "--pre-click-ms") == 0 && i + 1 < argc) {
      pre_click_ms = atoi(argv[++i]);
      continue;
    }
    if (strcmp(argv[i], "--point") == 0 && i + 1 < argc) {
      int x = 0;
      int y = 0;
      int wait_ms = 0;
      if (sscanf(argv[++i], "%d,%d,%d", &x, &y, &wait_ms) != 3) {
        die("invalid --point, expected x,y,wait_ms");
      }
      XTestFakeMotionEvent(display, -1, x, y, CurrentTime);
      XFlush(display);
      saw_point = 1;
      if (wait_ms > 0) {
        usleep((useconds_t)wait_ms * 1000);
      }
      continue;
    }
    die("unknown move-click argument");
  }

  if (!saw_point) {
    die("move-click requires at least one --point");
  }

  if (pre_click_ms > 0) {
    usleep((useconds_t)pre_click_ms * 1000);
  }
  XTestFakeButtonEvent(display, (unsigned int)button, True, CurrentTime);
  XFlush(display);
  if (hold_ms > 0) {
    usleep((useconds_t)hold_ms * 1000);
  }
  XTestFakeButtonEvent(display, (unsigned int)button, False, CurrentTime);
  XFlush(display);
}

static void command_move_click_rel(Display *display, int argc, char **argv) {
  require_xtest(display);
  int button = 1;
  int hold_ms = 0;
  int pre_click_ms = 0;
  int saw_point = 0;

  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--button") == 0 && i + 1 < argc) {
      button = atoi(argv[++i]);
      continue;
    }
    if (strcmp(argv[i], "--hold-ms") == 0 && i + 1 < argc) {
      hold_ms = atoi(argv[++i]);
      continue;
    }
    if (strcmp(argv[i], "--pre-click-ms") == 0 && i + 1 < argc) {
      pre_click_ms = atoi(argv[++i]);
      continue;
    }
    if (strcmp(argv[i], "--delta") == 0 && i + 1 < argc) {
      int dx = 0;
      int dy = 0;
      int wait_ms = 0;
      if (sscanf(argv[++i], "%d,%d,%d", &dx, &dy, &wait_ms) != 3) {
        die("invalid --delta, expected dx,dy,wait_ms");
      }
      XTestFakeRelativeMotionEvent(display, dx, dy, CurrentTime);
      XFlush(display);
      saw_point = 1;
      if (wait_ms > 0) {
        usleep((useconds_t)wait_ms * 1000);
      }
      continue;
    }
    die("unknown move-click-rel argument");
  }

  if (!saw_point) {
    die("move-click-rel requires at least one --delta");
  }

  if (pre_click_ms > 0) {
    usleep((useconds_t)pre_click_ms * 1000);
  }
  XTestFakeButtonEvent(display, (unsigned int)button, True, CurrentTime);
  XFlush(display);
  if (hold_ms > 0) {
    usleep((useconds_t)hold_ms * 1000);
  }
  XTestFakeButtonEvent(display, (unsigned int)button, False, CurrentTime);
  XFlush(display);
}

static void command_key(Display *display, int argc, char **argv) {
  require_xtest(display);
  if (argc < 3) {
    die("key requires a key name");
  }
  send_hotkey(display, argv[2]);
}

static void command_type(Display *display, int argc, char **argv) {
  require_xtest(display);
  int delay_ms = 20;
  const char *text = NULL;
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--delay-ms") == 0 && i + 1 < argc) {
      delay_ms = atoi(argv[++i]);
      continue;
    }
    text = argv[i];
  }
  if (!text) {
    die("type requires text");
  }
  send_text(display, text, delay_ms);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    die("usage: cueboard-xtest-input <probe|position|move-click|move-click-rel|key|type>");
  }

  Display *display = open_display();
  const char *command = argv[1];
  if (strcmp(command, "probe") == 0) {
    int json = argc >= 3 && strcmp(argv[2], "--json") == 0;
    command_probe(display, json);
  } else if (strcmp(command, "position") == 0) {
    command_position(display);
  } else if (strcmp(command, "move-click") == 0) {
    command_move_click(display, argc, argv);
  } else if (strcmp(command, "move-click-rel") == 0) {
    command_move_click_rel(display, argc, argv);
  } else if (strcmp(command, "key") == 0) {
    command_key(display, argc, argv);
  } else if (strcmp(command, "type") == 0) {
    command_type(display, argc, argv);
  } else {
    die("unknown command");
  }

  XCloseDisplay(display);
  return 0;
}
