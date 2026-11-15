package dev.momo.task;
/** A task's retreat ends at actual safety or a bounded obstruction, not one healed heart. */
final class CombatWithdrawal {
 private boolean active;private double best;private int improved;
 String update(float health,double distanceSquared,int tick){
  if(!active){if(health>6)return "";active=true;best=distanceSquared;improved=tick;}
  if(distanceSquared>=144)return "retreated_low_health";
  if(distanceSquared>best+1){best=distanceSquared;improved=tick;}
  return tick-improved>=80?"unreachable":"retreating";
 }
}
