package dev.momo.task;
import java.util.concurrent.atomic.AtomicInteger;
public final class SightLandmarksSmoke {
 public static void main(String[] args){
  var calls=new AtomicInteger();
  var hits=SightLandmarks.collect(0,64,0,(x,y,z)->{calls.incrementAndGet();return new SightLandmarks.Hit(20,64,0,"minecraft:oak_leaves",1);});
  if(calls.get()>128||hits.size()!=1)throw new AssertionError("Sight must be bounded and deduplicated");
  if(!SightLandmarks.collect(0,64,0,(x,y,z)->new SightLandmarks.Hit(1,64,0,"minecraft:stone",3)).isEmpty())throw new AssertionError("An occluding stone hit must not imply wood behind it");
  if(!SightLandmarks.collect(0,64,0,(x,y,z)->new SightLandmarks.Hit(100,64,0,"minecraft:oak_log",0)).isEmpty())throw new AssertionError("Distant coordinates exceeded sight budget");
  if(!SightLandmarks.collect(0,64,0,(x,y,z)->null).isEmpty())throw new AssertionError("Missing/unloaded ray must not create a landmark");
 }
}
