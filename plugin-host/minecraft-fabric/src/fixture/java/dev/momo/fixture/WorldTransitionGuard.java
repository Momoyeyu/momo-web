package dev.momo.fixture;
import java.nio.file.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;
/** Development artifact only: fixed test saves, never arbitrary commands or paths. */
public final class WorldTransitionGuard {
 public static final String FLAG="007-world-change",A="momo-007-transition-a",B="momo-007-transition-b";
 private WorldTransitionGuard(){}
 private static boolean exact(Path file,String expected)throws java.io.IOException{
  if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS))return false;
  byte[] bytes=expected.getBytes(StandardCharsets.UTF_8);
  try(var channel=Files.newByteChannel(file,Set.of(StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS))){
   if(channel.size()!=bytes.length)return false;
   var buffer=ByteBuffer.allocate(bytes.length+1);
   while(buffer.hasRemaining()&&channel.read(buffer)>0){}
   return buffer.position()==bytes.length&&Arrays.equals(bytes,Arrays.copyOf(buffer.array(),buffer.position()));
  }
 }
 private static boolean ownedSave(Path save)throws java.io.IOException{
  if(!Files.isDirectory(save,LinkOption.NOFOLLOW_LINKS)||!Files.isRegularFile(save.resolve("level.dat"),LinkOption.NOFOLLOW_LINKS))return false;
  if(!exact(save.resolve(".momo-transition-test"),"momo-007-transition-v1\n"))return false;
  // Fresh test saves are small. Refuse aliases at any depth and bound the
  // inspection instead of following a copied region/playerdata into real data.
  try(var paths=Files.walk(save)){
   int count=0;
   for(var iterator=paths.iterator();iterator.hasNext();){
    if(++count>512||Files.isSymbolicLink(iterator.next()))return false;
   }
  }
  return true;
 }
 public static Optional<Path> target(Path gameDir,Path from,String flag){
  if(!FLAG.equals(flag))return Optional.empty();
  try{
   Path root=gameDir.toRealPath(),saves=root.resolve("saves"),a=saves.resolve(A),b=saves.resolve(B);
   if(Files.isSymbolicLink(saves)||!from.toAbsolutePath().normalize().equals(a))return Optional.empty();
   for(Path save:List.of(a,b))if(!ownedSave(save))return Optional.empty();
   return Optional.of(b);
  }catch(java.io.IOException|java.io.UncheckedIOException error){return Optional.empty();}
 }
 public static Optional<Path> claim(Path gameDir,Path from,String flag){
  var target=target(gameDir,from,flag);if(target.isEmpty())return target;
  try{
   Path request=from.resolve(".momo-transition-request"),consumed=from.resolve(".momo-transition-consumed");
   if(!exact(request,"switch\n"))return Optional.empty();
   Files.writeString(consumed,"momo-007-transition-v1\n",StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE);
   Files.delete(request);return target;
  }catch(java.io.IOException error){return Optional.empty();}
 }
}
