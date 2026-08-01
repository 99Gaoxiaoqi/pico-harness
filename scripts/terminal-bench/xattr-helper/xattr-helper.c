// Minimal Linux xattr helper for the sealed Terminal-Bench bundle.
// It intentionally operates only on a pathname supplied by Pico after its
// /proc/<pid>/fd binding check.  No shell, interpreter, or libattr is needed.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/xattr.h>

static void fail(const char *operation, const char *detail) {
  fprintf(stderr, "{\"error\":\"xattr-helper\",\"operation\":\"%s\",\"errno\":%d,\"detail\":\"%s\"}\n", operation, errno, detail);
  exit(1);
}
static int hex(unsigned char value) { return value < 10 ? '0' + value : 'a' + value - 10; }
static unsigned char unhex(char value) {
  if (value >= '0' && value <= '9') return (unsigned char)(value - '0');
  if (value >= 'a' && value <= 'f') return (unsigned char)(value - 'a' + 10);
  if (value >= 'A' && value <= 'F') return (unsigned char)(value - 'A' + 10);
  return 255;
}
static unsigned char *decode_hex(const char *text, size_t *size) {
  if (strncmp(text, "0x", 2) || strlen(text) % 2) { errno = EINVAL; fail("set", "invalid hex value"); }
  *size = (strlen(text) - 2) / 2;
  unsigned char *result = malloc(*size ? *size : 1);
  if (!result) fail("set", "allocation failed");
  for (size_t i = 0; i < *size; i++) {
    unsigned char a = unhex(text[2 + i * 2]), b = unhex(text[3 + i * 2]);
    if (a == 255 || b == 255) { errno = EINVAL; fail("set", "invalid hex value"); }
    result[i] = (unsigned char)((a << 4) | b);
  }
  return result;
}
static int compare_names(const void *left, const void *right) { return strcmp(*(const char * const *)left, *(const char * const *)right); }
static void dump(const char *path) {
  ssize_t listed = listxattr(path, NULL, 0);
  if (listed < 0) fail("dump", "listxattr failed");
  char *names = malloc((size_t)listed ? (size_t)listed : 1);
  if (!names) fail("dump", "allocation failed");
  if (listed && listxattr(path, names, (size_t)listed) != listed) fail("dump", "xattr list changed");
  size_t count = 0;
  for (ssize_t offset = 0; offset < listed; offset += (ssize_t)strlen(names + offset) + 1) count++;
  char **ordered = calloc(count ? count : 1, sizeof(*ordered));
  if (!ordered) fail("dump", "allocation failed");
  size_t index = 0;
  for (ssize_t offset = 0; offset < listed; offset += (ssize_t)strlen(names + offset) + 1) ordered[index++] = names + offset;
  qsort(ordered, count, sizeof(*ordered), compare_names);
  for (index = 0; index < count; index++) {
    ssize_t size = getxattr(path, ordered[index], NULL, 0);
    if (size < 0) fail("dump", "getxattr failed");
    unsigned char *value = malloc((size_t)size ? (size_t)size : 1);
    if (!value) fail("dump", "allocation failed");
    if (size && getxattr(path, ordered[index], value, (size_t)size) != size) fail("dump", "xattr value changed");
    printf("%s=0x", ordered[index]);
    for (ssize_t i = 0; i < size; i++) { putchar(hex(value[i] >> 4)); putchar(hex(value[i] & 15)); }
    putchar('\n'); free(value);
  }
  free(ordered); free(names);
}
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "dump")) { dump(argv[2]); return 0; }
  if (argc == 5 && !strcmp(argv[1], "set")) { size_t size; unsigned char *value = decode_hex(argv[3], &size); if (setxattr(argv[4], argv[2], value, size, 0)) fail("set", "setxattr failed"); free(value); return 0; }
  if (argc == 4 && !strcmp(argv[1], "remove")) { if (removexattr(argv[3], argv[2])) fail("remove", "removexattr failed"); return 0; }
  errno = EINVAL; fail("usage", "expected dump PATH | set NAME HEX PATH | remove NAME PATH");
}
