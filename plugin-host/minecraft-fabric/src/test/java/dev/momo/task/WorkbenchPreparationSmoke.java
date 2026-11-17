package dev.momo.task;
import java.util.*;
public final class WorkbenchPreparationSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static class Work extends TaskRuntimeSmoke.Work {}
 static Work absent(){return new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed("station_required");}};}
 static Map<String,Object> target(){return Map.of("x",6,"y",64,"z",4);}
 static Work placement(){return new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("placement",Map.of("x",6,"y",64,"z",4,"serverBlockSeq",20)));}};}
 static Work opened(){return new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("screen","minecraft:crafting","serverWindowSeq",21));}};}
 public static void main(String[] args){
  int[] placements={0},opens={0};
  var found=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(target());}};
  var existing=new WorkbenchPreparation(found,()->{placements[0]++;return placement();},point->{check(point.equals(target()),"Open the actually found table");opens[0]++;return opened();});
  existing.start();existing.tick();var result=existing.tick();
  check(result.state().equals("succeeded")&&placements[0]==0&&opens[0]==1,"An existing station must not consume a carried workbench");existing.stop();

  var placed=placement();var opening=opened();int[] factories={0};
  var preparation=new WorkbenchPreparation(absent(),()->{factories[0]++;return placed;},point->{check(point.equals(target()),"Use the confirmed placement position, never a guessed site");return opening;});
  var recipe=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("item","minecraft:chest","countBefore",0,"countAfter",1));}};
  var craft=new PreparedCraftSkill(()->preparation,()->recipe);craft.start();craft.tick();
  check(placed.starts==1&&opening.starts==0&&recipe.starts==0,"A missing visible station must place an owned workbench before opening or crafting");
  craft.pause();craft.tick();craft.resume();check(placed.pauses==1&&placed.resumes==1&&factories[0]==1,"Paused placement must not advance or allocate a second workbench");
  craft.tick();check(opening.starts==1&&recipe.starts==0,"Placement proof alone is not an opened crafting grid");
  craft.tick();check(recipe.starts==1,"Only confirmed opening starts the actual recipe");
  result=craft.tick();var station=(Map<?,?>)result.evidence().get("stationPreparation");
  check(result.state().equals("succeeded")&&result.evidence().get("countAfter").equals(1)&&station.get("serverWindowSeq").equals(21)&&station.containsKey("placedWorkbench"),"The crafted item retains both real placement and window proof");craft.stop();

  var missing=new WorkbenchPreparation(absent(),()->null,point->{throw new AssertionError("No owned workbench cannot open a new station");});
  missing.start();check(missing.tick().reason().equals("station_required"),"No owned station remains an explicit failure");missing.stop();
  var unknown=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed("server_confirmation_missing");}};
  var uncertain=new WorkbenchPreparation(absent(),()->unknown,point->{throw new AssertionError("Unknown placement cannot start opening");});
  uncertain.start();uncertain.tick();check(uncertain.tick().reason().equals("server_confirmation_missing")&&unknown.starts==1,"Unknown world effects must never be replayed as another placement");uncertain.stop();
  check(uncertain.tick().reason().equals("activity_ended"),"A stopped preparation cannot restart on a late tick");

  var blocked=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed("server_confirmation_missing");}};
  var existingFailure=new WorkbenchPreparation(blocked,()->{throw new AssertionError("A failed known operation is not a missing station");},point->opened());
  existingFailure.start();check(existingFailure.tick().reason().equals("server_confirmation_missing"),"Only exhausted station search can trigger placement");existingFailure.stop();

  var pendingOpen=new Work();var stopped=new WorkbenchPreparation(absent(),WorkbenchPreparationSmoke::placement,point->pendingOpen);
  var runtime=new TaskRuntime();runtime.submit("owned-station","craft",stopped,0,1000);runtime.tick(1);runtime.tick(2);runtime.stop("manual_takeover");runtime.tick(3);
  check(pendingOpen.starts==1&&pendingOpen.stops==1&&stopped.partialEvidence().containsKey("placedWorkbench"),"Takeover retains an already placed block and cannot continue opening or crafting");
  stopped.resume();stopped.pause();stopped.stop();
  check(pendingOpen.resumes==0&&pendingOpen.pauses==0&&pendingOpen.stops==1,"Late lifecycle calls cannot reacquire input or replay child cleanup after stop");
  System.out.println("PASS carried workbench placement, existing station priority, receipts and cancellation");
 }
}
