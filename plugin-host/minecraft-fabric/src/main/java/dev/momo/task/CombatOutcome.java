package dev.momo.task;
/** Disappearance is not proof of defeating an entity. */
public enum CombatOutcome {
 ACTIVE,DEAD,LOST;
 public static CombatOutcome of(boolean removed,boolean killed,float health){return killed||health<=0?DEAD:removed?LOST:ACTIVE;}
}
