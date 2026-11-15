package dev.momo.task;
import java.util.*;
public final class PreparedMineSkillSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static class Work extends TaskRuntimeSmoke.Work {int hits;}
 public static void main(String[] args){
  boolean[] suitable={false};int[] preparations={0};
  var mine=new Work(){
   public void start(){super.start();suitable[0]=false;} // A restarted old raw selector would replace iron with faster gold.
   public TaskRuntime.Step tick(){check(suitable[0],"wrong harvest tool reached real breaking");hits++;return hits==1?TaskRuntime.Step.running():TaskRuntime.Step.done(Map.of("serverBlockSeq",9));}
  };
  var prepared=new PreparedMineSkill(mine,()->{
   preparations[0]++;return new Work(){public TaskRuntime.Step tick(){suitable[0]=true;return TaskRuntime.Step.done(Map.of("item","minecraft:iron_pickaxe"));}};
  },()->suitable[0]);
  prepared.start();var result=prepared.tick();
  check(result.state().equals("running")&&mine.starts==1&&mine.hits==1,"a verified suitable tool must survive preparation without restarting the raw selector");
  prepared.pause();suitable[0]=false;prepared.resume();result=prepared.tick();
  check(preparations[0]==2&&mine.starts==1&&mine.hits==2,"a resumed body rechecks tools without resetting the original mining receipt boundary");
  check(result.state().equals("succeeded")&&result.evidence().containsKey("toolPreparation")&&result.evidence().get("serverBlockSeq").equals(9),"tool selection is supporting evidence, not a replacement for the actual block result");
  boolean[] neverSuitable={false};var noHit=new Work(){public TaskRuntime.Step tick(){hits++;return TaskRuntime.Step.running();}};
  var wrongSelection=new PreparedMineSkill(noHit,()->new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("item","same_id_wrong_components"));}},()->neverSuitable[0]);
  wrongSelection.start();check(wrongSelection.tick().reason().equals("tool_required")&&noHit.hits==0,"a successful item selection receipt cannot bypass actual stack harvest suitability");
  var slowPrep=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.running();}public Map<String,Object> partialEvidence(){return Map.of("verifiedSwap",true);}};
  var cancelledMine=new Work(){public TaskRuntime.Step tick(){hits++;return TaskRuntime.Step.running();}};
  var pending=new PreparedMineSkill(cancelledMine,()->slowPrep,()->false);var runtime=new TaskRuntime();
  runtime.submit("pending","mine",pending,0,1000);runtime.tick(1);runtime.stop("manual_takeover");runtime.tick(2);
  check(cancelledMine.hits==0&&cancelledMine.stops==1&&slowPrep.stops==1,"takeover during preparation never dispatches mining or a cleanup inventory click");
  check(!runtime.snapshot("pending").evidence().isEmpty(),"confirmed preparation changes survive cancellation");
  var retryBody=new Work(){public TaskRuntime.Step tick(){return starts==1?TaskRuntime.Step.failed("target_not_visible"):TaskRuntime.Step.done(Map.of("serverBlockSeq",10));}};
  var retryMine=new PreparedMineSkill(retryBody,()->new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("item","minecraft:iron_pickaxe"));}},()->true);
  var retryPlan=new TaskPlan(List.of(new TaskPlan.Node(retryMine,()->true,1,false)));
  retryPlan.start();check(retryPlan.tick().state().equals("running"),"known pre-harvest failure can retry within its declared bound");
  check(retryPlan.tick().state().equals("succeeded")&&retryBody.starts==2&&retryBody.stops==2,"each mining retry owns and releases its body exactly once, including after the previous attempt was closed");
  System.out.println("PASS prepared tool ownership, resume validation, actual harvest gate and cancellation");
 }
}
