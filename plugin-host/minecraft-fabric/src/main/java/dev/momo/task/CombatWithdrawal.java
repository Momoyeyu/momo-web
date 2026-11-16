package dev.momo.task;
/** A task's retreat ends at actual safety or a bounded obstruction, not one healed heart. */
final class CombatWithdrawal {
 private boolean active,ranged;private double best;private int improved;
 String update(float health,double distanceSquared,int tick,boolean rangedThreat){
  return update(health,distanceSquared,tick,rangedThreat,true);
 }
 String update(float health,double distanceSquared,int tick,boolean rangedThreat,boolean dangerous){
  if(!active&&!dangerous)return "";
  if(!active){if(health>6)return "";active=true;best=distanceSquared;improved=tick;}
  ranged|=rangedThreat;
  // Ranged danger is recognized out to 24 blocks. Keep four blocks of margin
  // instead of declaring safety at the melee separation of twelve blocks.
  if(distanceSquared>=(ranged?784:144))return "retreated_low_health";
  if(distanceSquared>best+1){best=distanceSquared;improved=tick;}
  return tick-improved>=80?"unreachable":"retreating";
 }
}
