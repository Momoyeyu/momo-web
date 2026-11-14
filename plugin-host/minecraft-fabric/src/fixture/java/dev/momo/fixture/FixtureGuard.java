package dev.momo.fixture;
import java.nio.file.*;
/** Test artifact only. No production entrypoint or game-tool access. */
public final class FixtureGuard {
 public static boolean allowed(Path save,String flag){
  if(!"007-fixtures".equals(flag))return false;
  try{
   if(Files.isSymbolicLink(save)||!save.toRealPath().getFileName().toString().equals("momo-007-fixtures"))return false;
   Path marker=save.resolve(".momo-fixture-setup");String expected="momo-007-fixtures-v1\n";
   if(!Files.isRegularFile(marker)||Files.size(marker)!=expected.length()||!Files.readString(marker).equals(expected)||Files.exists(save.resolve(".momo-fixture-prepared")))return false;
   Path players=save.resolve("playerdata");
   if(Files.isDirectory(players))try(var entries=Files.list(players)){if(entries.findAny().isPresent())return false;}
   return true;
  }catch(java.io.IOException error){return false;}
 }
}
