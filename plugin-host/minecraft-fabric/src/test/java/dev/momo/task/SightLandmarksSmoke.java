package dev.momo.task;
import java.util.concurrent.atomic.AtomicInteger;
public final class SightLandmarksSmoke {
 public static void main(String[] args){
  var calls=new AtomicInteger();
  var hits=SightLandmarks.collect(0,64,0,(x,y,z)->{calls.incrementAndGet();return new SightLandmarks.Hit(20,64,0,"minecraft:oak_leaves",1);});
  if(calls.get()>128||hits.size()!=1)throw new AssertionError("Sight must be bounded and deduplicated");
  if(!SightLandmarks.collect(0,64,0,(x,y,z)->new SightLandmarks.Hit(1,64,0,"minecraft:stone",3)).isEmpty())throw new AssertionError("An occluding stone hit must not imply wood behind it");
  var distantCanopy=SightLandmarks.collect(0,64,0,(x,y,z)->{
   if(z<=0)return null;double t=80/z;
   return t<=1&&Math.abs(t*x)<=3&&t*y>=2&&t*y<=6?new SightLandmarks.Hit(0,68,80,"minecraft:oak_leaves",1):null;
  });
  if(distantCanopy.isEmpty())throw new AssertionError("Shallow visible canopy must be sampled, not only steep sky/ground angles");
  var betweenRays=SightLandmarks.collect(0,64,0,(x,y,z)->{
   if(z<=0)return null;double t=80/z;
   return t<=1&&Math.abs(t*x+10)<=2&&t*y>=2&&t*y<=6?new SightLandmarks.Hit(-10,68,80,"minecraft:oak_leaves",1):null;
  });
  if(betweenRays.isEmpty())throw new AssertionError("Visible canopy inside camera view must not fall between coarse global rays");
  var uphill=SightLandmarks.collect(0,64,0,0,-40,(x,y,z)->{
   if(z<=0)return null;double t=60/z;
   return t<=1&&Math.abs(t*x)<=3&&t*y>=48&&t*y<=54?new SightLandmarks.Hit(0,115,60,"minecraft:oak_leaves",1):null;
  });
  if(uphill.isEmpty())throw new AssertionError("Looking up at a ridge must also aim landmark perception up");
  if(!SightLandmarks.collect(0,64,0,(x,y,z)->new SightLandmarks.Hit(200,64,0,"minecraft:oak_log",0)).isEmpty())throw new AssertionError("Distant coordinates exceeded sight budget");
  if(!SightLandmarks.collect(0,64,0,(x,y,z)->null).isEmpty())throw new AssertionError("Missing/unloaded ray must not create a landmark");
 }
}
