package dev.momo.task;
/** Small deterministic arbiter; no LLM decisions or permission changes. */
public final class SurvivalPolicy {
 public enum Mode {NONE,EAT,DEFEND,ESCAPE}
 public boolean airCritical(int air,boolean escaping){return air<100||(escaping&&air<250);}
 public float escapePitch(boolean recoveringAir,float previous){return recoveringAir?-60:previous;}
 public boolean canDrive(boolean paused,boolean focused,boolean screenOpen,boolean mealScreen){return !paused&&focused&&(!screenOpen||mealScreen);}
 public Mode forBody(Mode desired,boolean skillEating,boolean combatOwned){
  if(desired==Mode.ESCAPE)return desired;
  if(skillEating||(combatOwned&&desired==Mode.DEFEND))return Mode.NONE;
  return desired;
 }
 public boolean interruptOwnedScreen(Mode mode,boolean owned){return owned&&(mode==Mode.DEFEND||mode==Mode.ESCAPE);}
 public Mode choose(boolean authorized,boolean stopped,boolean critical,float health,int food,boolean hasFood,boolean eating,boolean hostile){
  if(!authorized||stopped)return Mode.NONE;
  if(critical||(health<=6&&hostile))return Mode.ESCAPE;
  if(eating&&hasFood)return Mode.EAT;
  if(hasFood&&food<=14&&!hostile)return Mode.EAT;
  return hostile?Mode.DEFEND:Mode.NONE;
 }
}
