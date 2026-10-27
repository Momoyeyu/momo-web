// Original host for the unchanged vendor runtime. Never runs QQ's app entry.
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

typedef int (*NodeEntry)(int, char **);
int main(int argc, char **argv) {
  if (argc != 4 || argv[1][0] != '/' || argv[2][0] != '/' || argv[3][0] != '/') {
    fputs("MOMO_QQ_REFUSED_ARGUMENTS\n", stderr); return 78;
  }
  errno = 0;
  int canary = open(argv[1], O_RDONLY);
  int failure = errno;
  if (canary >= 0) { close(canary); fputs("MOMO_QQ_REFUSED_BARRIER\n", stderr); return 78; }
  if (failure != EPERM && failure != EACCES) { fputs("MOMO_QQ_REFUSED_CANARY\n", stderr); return 78; }
  @autoreleasepool {
    NSString *framework = [[[NSBundle mainBundle] privateFrameworksPath]
      stringByAppendingPathComponent:@"QQNT.framework/Versions/A/QQNT"];
    void *library = dlopen([framework fileSystemRepresentation], RTLD_NOW | RTLD_GLOBAL);
    if (!library) { fputs("MOMO_QQ_RUNTIME_LOAD_FAILED\n", stderr); return 79; }
    NodeEntry entry = (NodeEntry)dlsym(library, "ElectronInitializeICUandStartNode");
    if (!entry) { fputs("MOMO_QQ_RUNTIME_ENTRY_FAILED\n", stderr); return 80; }
    // This vendor entry retains its own RunAsNode fuse check.
    char *nodeArgv[] = { argv[0], argv[2], argv[3], NULL };
    return entry(3, nodeArgv);
  }
}
