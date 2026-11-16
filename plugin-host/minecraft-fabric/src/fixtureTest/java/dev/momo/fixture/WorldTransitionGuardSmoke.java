package dev.momo.fixture;
import java.nio.file.*;
import java.util.Comparator;
/** Even the development client driver may only switch its own two marked saves. */
public final class WorldTransitionGuardSmoke {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path root=Files.createTempDirectory("momo-transition-guard-").toRealPath();
  try{
   Path saves=Files.createDirectory(root.resolve("saves"));
   Path a=Files.createDirectory(saves.resolve("momo-007-transition-a"));
   Path b=Files.createDirectory(saves.resolve("momo-007-transition-b"));
   Files.writeString(a.resolve("level.dat"),"test metadata");Files.writeString(b.resolve("level.dat"),"test metadata");
   String flag="007-world-change",marker="momo-007-transition-v1\n";
   check(WorldTransitionGuard.target(root,a,flag).isEmpty(),"names/flag alone never authorize a world change");
   Files.writeString(a.resolve(".momo-transition-test"),marker);
   check(WorldTransitionGuard.target(root,a,flag).isEmpty(),"the destination also needs its own marker");
   Files.writeString(b.resolve(".momo-transition-test"),marker);
   check(WorldTransitionGuard.target(root,a,flag).orElseThrow().equals(b),"only A to B is allowed");
   check(WorldTransitionGuard.target(root,a,"").isEmpty(),"normal launches have no driver");
   check(WorldTransitionGuard.target(root,b,flag).isEmpty(),"B cannot loop back into another transition");
   Path ordinary=Files.createDirectory(saves.resolve("my-survival"));Files.writeString(ordinary.resolve(".momo-transition-test"),marker);
   check(WorldTransitionGuard.target(root,ordinary,flag).isEmpty(),"copying a marker cannot authorize a normal save");
   check(WorldTransitionGuard.claim(root,a,flag).isEmpty(),"a valid pair does nothing without a request");
   Path request=a.resolve(".momo-transition-request");Files.writeString(request,"other\n");
   check(WorldTransitionGuard.claim(root,a,flag).isEmpty(),"no arbitrary command or target is parsed");
   Files.writeString(request,"switch\n");
   check(WorldTransitionGuard.claim(root,a,flag).orElseThrow().equals(b),"consume an explicit fixed request once");
   Files.writeString(request,"switch\n");
   check(WorldTransitionGuard.claim(root,a,flag).isEmpty(),"restarting or replaying the request cannot repeat it");
   Files.delete(b.resolve(".momo-transition-test"));Files.writeString(b.resolve(".momo-transition-test"),marker+"extra");
   check(WorldTransitionGuard.target(root,a,flag).isEmpty(),"malformed/oversized markers fail closed");
   Files.delete(b.resolve(".momo-transition-test"));Files.writeString(b.resolve(".momo-transition-test"),marker);
   try{
    Files.createSymbolicLink(b.resolve("region"),ordinary);
    check(WorldTransitionGuard.target(root,a,flag).isEmpty(),"a region alias must not write into another save");
    Files.delete(b.resolve("region"));
    Files.delete(b.resolve(".momo-transition-test"));Files.createSymbolicLink(b.resolve(".momo-transition-test"),a.resolve(".momo-transition-test"));
    check(WorldTransitionGuard.target(root,a,flag).isEmpty(),"a marker alias is not permission");
    Files.delete(b.resolve(".momo-transition-test"));Files.delete(b.resolve("level.dat"));Files.delete(b);Files.createSymbolicLink(b,ordinary);
    check(WorldTransitionGuard.target(root,a,flag).isEmpty(),"a target alias cannot load an ordinary save");
   }catch(UnsupportedOperationException|FileSystemException unsupported){System.out.println("SKIP symlink creation unavailable on this developer filesystem");}
  }finally{try(var paths=Files.walk(root)){for(Path path:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(path);}}
  System.out.println("PASS fixed two-save transition, explicit opt-in, one-shot request and no symlink aliases");
 }
}
