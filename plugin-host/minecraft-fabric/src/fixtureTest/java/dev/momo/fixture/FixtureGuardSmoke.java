package dev.momo.fixture;
import java.nio.file.*;
public final class FixtureGuardSmoke {
 private static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
 public static void main(String[] args)throws Exception{
  Path root=Files.createTempDirectory("momo-fixture-guard-");
  try{
   Path world=Files.createDirectory(root.resolve("momo-007-fixtures"));
   check(!FixtureGuard.allowed(world,"007-fixtures"),"a flag alone cannot modify a world");
   Files.writeString(world.resolve(".momo-fixture-setup"),"momo-007-fixtures-v1\n");
   check(FixtureGuard.allowed(world,"007-fixtures"),"an explicitly marked disposable world can be prepared once");
   try{
    Path alias=root.resolve("world-alias");Files.createSymbolicLink(alias,world);
    check(!FixtureGuard.allowed(alias,"007-fixtures"),"a symbolic alias may not target a real world through the fixture guard");
   }catch(UnsupportedOperationException|FileSystemException unsupported){System.out.println("SKIP symlink creation unavailable on this developer filesystem");}
   check(!FixtureGuard.allowed(world,""),"normal launches never prepare anything");
   Path ordinary=Files.createDirectory(root.resolve("my-survival-world"));Files.copy(world.resolve(".momo-fixture-setup"),ordinary.resolve(".momo-fixture-setup"));
   check(!FixtureGuard.allowed(ordinary,"007-fixtures"),"even a copied marker cannot authorize an ordinary save");
   Path players=Files.createDirectory(world.resolve("playerdata"));Files.writeString(players.resolve("existing-player.dat"),"real data");
   check(!FixtureGuard.allowed(world,"007-fixtures"),"previously played worlds cannot be seeded");Files.delete(players.resolve("existing-player.dat"));
   Files.writeString(world.resolve(".momo-fixture-prepared"),"done");
   check(!FixtureGuard.allowed(world,"007-fixtures"),"restart must never replay fixture side effects");
   check(!FixtureGuard.allowed(root.resolve("missing"),"007-fixtures"),"missing save fails closed");
  }finally{try(var paths=Files.walk(root)){for(var path:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.delete(path);}}
  System.out.println("PASS fixture opt-in, save isolation, existing-player guard and one-shot barrier");
  WorldTransitionGuardSmoke.main(args);
 }
}
