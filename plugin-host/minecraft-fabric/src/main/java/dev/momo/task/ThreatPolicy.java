package dev.momo.task;
/** Visible threat classification, not omniscient mob targeting or a new objective loop. */
public final class ThreatPolicy {
 private ThreatPolicy(){}
 // Client damage packets update recentDamageSource, not the server-side attacker field.
 public static boolean recent(boolean tracked,int age,boolean damageSource){return damageSource||tracked&&age>=0&&age<=120;}
 public static boolean danger(boolean visible,boolean monster,boolean neutral,boolean aggressive,boolean recentAttacker,boolean ranged,double distanceSquared){
  if(!visible||!Double.isFinite(distanceSquared)||distanceSquared<0||distanceSquared>1024)return false;
  if(recentAttacker)return true;
  if(!monster||neutral&&!aggressive)return false;
  return distanceSquared<=(ranged?576:64);
 }
}
