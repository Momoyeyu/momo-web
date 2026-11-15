package dev.momo.task;
import java.util.*;
/** Only visible fuse cues enter memory; withdrawal uses their last seen points. */
public final class BlastAvoidance {
 public record Creeper(int id,double x,double y,double z,boolean visible,boolean priming,boolean charged){
  double radius(){return charged?13:7;} // Vanilla entity blast range (12/6), plus one block of separation.
  double distance(double px,double py,double pz){return (px-x)*(px-x)+(py-y)*(py-y)+(pz-z)*(pz-z);}
  double separation(double px,double py,double pz){return distance(px,py,pz)/(radius()*radius());}
 }
 private final Map<Integer,Creeper> known=new LinkedHashMap<>();
 public void update(double x,double y,double z,List<Creeper> observations){
  for(var seen:observations){
   if(!seen.visible())continue;
   if(known.containsKey(seen.id())||seen.priming()&&seen.separation(x,y,z)<1)known.put(seen.id(),seen);
  }
  known.values().removeIf(seen->seen.separation(x,y,z)>=1);
  if(known.size()>16){
   var closest=known.values().stream().sorted(Comparator.comparingDouble(seen->seen.separation(x,y,z))).limit(16).toList();
   known.clear();for(var seen:closest)known.put(seen.id(),seen);
  }
 }
 public boolean active(){return !known.isEmpty();}
 public double score(double x,double y,double z){
  double distance=Double.POSITIVE_INFINITY;
  for(var seen:known.values())distance=Math.min(distance,seen.separation(x,y,z));
  return distance;
 }
 public void clear(){known.clear();}
}
