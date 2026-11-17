package dev.momo.task;
import java.util.*;
public final class BlastAvoidanceSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static BlastAvoidance.Creeper view(int id,double x,boolean visible,boolean priming,boolean charged){return new BlastAvoidance.Creeper(id,x,0,0,visible,priming,charged);}
 public static void main(String[] args){
  var blast=new BlastAvoidance();var policy=new SurvivalPolicy();
  blast.update(0,0,0,List.of(view(1,3,true,true,false)));
  check(blast.active(),"a visible priming creeper is critical even with full health");
  var desired=policy.choose(true,false,blast.active(),20,20,20,false,false,true);
  check(policy.forBody(desired,true,true)==SurvivalPolicy.Mode.ESCAPE,"blast escape preempts owned melee and eating, rather than approaching for defense");
  blast.update(0,0,0,List.of(view(1,3,true,false,false)));
  check(blast.active(),"brief defusing must not send the body straight back into the blast radius");
  blast.update(0,0,0,List.of(view(1,99,false,true,false)));
  check(blast.active()&&blast.score(-2,0,0)>blast.score(2,0,0),"an occluded source keeps its last seen location; hidden live coordinates cannot change escape direction");
  blast.update(-7,0,0,List.of());check(!blast.active(),"withdrawal finishes after actual separation from the known blast point");
  blast.update(0,0,0,List.of(view(2,3,false,true,false)));check(!blast.active(),"an unseen priming mob cannot be discovered through walls");
  blast.update(0,0,0,List.of(view(3,10,true,true,false)));check(!blast.active(),"distant normal creepers do not unnecessarily interrupt the goal");
  blast.update(0,0,0,List.of(view(4,10,true,true,true)));check(blast.active(),"charged visible creepers need their larger blast envelope");
  blast.clear();blast.update(0,0,0,List.of(view(5,-3,true,true,false),view(6,3,true,true,false)));
  check(blast.score(0,0,2)>blast.score(2,0,0),"escaping one blast may not aim straight at another visible fuse");
  blast.clear();check(!blast.active(),"stop clears local hazard ownership and cannot restart a retired body");
  System.out.println("PASS visible fuse priority, latched safe withdrawal, charged range and last-seen knowledge");
 }
}
