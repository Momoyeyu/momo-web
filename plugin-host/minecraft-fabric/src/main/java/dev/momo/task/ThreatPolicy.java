package dev.momo.task;
/** Visible threat classification, not omniscient mob targeting or a new objective loop. */
public final class ThreatPolicy {
 private ThreatPolicy(){}
 public static boolean danger(boolean visible,boolean monster,boolean neutral,boolean aggressive,boolean recentAttacker,boolean ranged,double distanceSquared){
  if(!visible||!Double.isFinite(distanceSquared)||distanceSquared<0||distanceSquared>1024)return false;
  if(recentAttacker)return true;
  if(!monster||neutral&&!aggressive)return false;
  return distanceSquared<=(ranged?576:64);
 }
}
