package dev.momo.task;
/** Small deterministic arbiter; no LLM decisions or permission changes. */
public final class SurvivalPolicy {
 public enum Mode {NONE,EAT,DEFEND,ESCAPE}
 public boolean interruptOwnedScreen(Mode mode,boolean owned){return owned&&(mode==Mode.DEFEND||mode==Mode.ESCAPE);}
 public Mode choose(boolean authorized,boolean stopped,boolean critical,float health,int food,boolean hasFood,boolean eating,boolean hostile){
  if(!authorized||stopped)return Mode.NONE;
  if(critical||(health<=4&&hostile))return Mode.ESCAPE;
  if(eating&&hasFood)return Mode.EAT;
  if(hasFood&&food<=14&&!hostile)return Mode.EAT;
  return hostile?Mode.DEFEND:Mode.NONE;
 }
}
