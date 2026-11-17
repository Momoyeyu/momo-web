package dev.momo.task;
import java.util.*;
public final class PreparedCraftSkillSmoke {
 static void check(boolean actual,String why){if(!actual)throw new AssertionError(why);}
 static class Work extends TaskRuntimeSmoke.Work {}
 public static void main(String[] args){
  WorkbenchPreparationSmoke.main(args);
  int[] seen={0},prepared={0};var screen=new Object();
  var station=new Work(){
   public TaskRuntime.Step tick(){return ++seen[0]<2?TaskRuntime.Step.running():TaskRuntime.Step.done(Map.of("serverWindowSeq",11,"screen","minecraft:crafting"));}
   public boolean acceptsScreen(Object value){return value==screen;}
  };
  var recipe=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("item","minecraft:oak_door","countBefore",0,"countAfter",3,"serverRevision",8));}};
  var work=new PreparedCraftSkill(()->{prepared[0]++;return station;},()->recipe);
  work.start();check(station.starts==1&&recipe.starts==0,"A 3x3 recipe must open its visible workbench before sending a recipe click");
  check(work.acceptsScreen(screen),"The correlated station screen remains owned during preparation");
  check(work.tick().state().equals("running")&&recipe.starts==0,"An accepted or pending station is not a crafted item");
  work.pause();work.resume();check(station.pauses==1&&station.resumes==1&&prepared[0]==1,"Pause and resume must not reopen or replay station work");
  check(work.tick().state().equals("running")&&station.stops==1&&recipe.starts==1,"Confirmed preparation hands off once to the existing recipe body");
  var result=work.tick();check(result.state().equals("succeeded")&&result.evidence().get("countAfter").equals(3),"Success must retain the actual server-backed inventory gain");
  check(((Map<?,?>)result.evidence().get("stationPreparation")).get("serverWindowSeq").equals(11),"The station receipt supports rather than replaces the crafted output");work.stop();
  var smallRecipe=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("countAfter",4));}};
  var small=new PreparedCraftSkill(()->null,()->smallRecipe);small.start();check(small.tick().state().equals("succeeded")&&smallRecipe.starts==1,"2x2 recipes and already-open crafting grids need no new station action");
  var absent=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed("station_required");}};var never=new Work();
  var missing=new PreparedCraftSkill(()->absent,()->never);missing.start();check(missing.tick().reason().equals("station_required")&&never.starts==0,"No visible workbench remains an honest failure with no recipe dispatch");missing.stop();
  var slow=new Work();var late=new Work();var stopped=new PreparedCraftSkill(()->slow,()->late);
  var runtime=new TaskRuntime();runtime.submit("craft","craft",stopped,0,1000);runtime.tick(1);runtime.stop("manual_takeover");runtime.tick(2);
  check(slow.stops==1&&late.starts==0,"Takeover during station search must never start crafting later");
  check(stopped.tick().reason().equals("activity_ended"),"A late local tick cannot reactivate a stopped preparation");
  var opened=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("serverWindowSeq",12));}};
  var uncertain=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed("server_confirmation_missing");}public Map<String,Object> partialEvidence(){return Map.of("countAfter",1);}};
  var unknown=new PreparedCraftSkill(()->opened,()->uncertain);unknown.start();unknown.tick();check(unknown.tick().reason().equals("server_confirmation_missing")&&uncertain.starts==1,"Unknown recipe outcome cannot restart ingredient consumption");
  check(unknown.partialEvidence().containsKey("stationPreparation")&&unknown.partialEvidence().get("countAfter").equals(1),"Failure and cancellation retain real partial work");unknown.stop();
  System.out.println("PASS visible station preparation, verified recipe output, pause and takeover");
 }
}
