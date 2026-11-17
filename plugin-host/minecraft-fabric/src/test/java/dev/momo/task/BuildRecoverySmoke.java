package dev.momo.task;
import java.util.*;
/** A locally stuck builder can change vantage without forgetting confirmed work. */
final class BuildRecoverySmoke {
 static void run(){
  var a=BuildTaskSmoke.A;var b=BuildTaskSmoke.B;
  var scene=new BuildTaskSmoke.Scene(){
   public TaskRuntime.Work build(List<SparseBuild.Cell> cells){
    if(!builds.isEmpty()){
     BuildTaskSmoke.check(cells.equals(List.of(b)),"Recovery must not resubmit already confirmed cells");
     return super.build(cells);
    }
    var first=new BuildTaskSmoke.Work(TaskRuntime.Step.failed("build_blocked")){
     public TaskRuntime.Step tick(){placed.add(a);return super.tick();}
     public Map<String,Object> partialEvidence(){return Map.of("confirmedCells",List.of(Map.of("x",0,"y",66,"z",0,"block","Block{minecraft:dirt}","serverBlockSeq",1L)));}
    };
    builds.add(first);return first;
   }
  };
  scene.visible.addAll(List.of(a,b));var work=new BuildTask(List.of(a,b),scene);work.start();
  var result=BuildTaskSmoke.finish(work);
  BuildTaskSmoke.check(result.state().equals("succeeded"),"A locally blocked builder must approach and finish the remaining cells within the same task");
  BuildTaskSmoke.check(((List<?>)result.evidence().get("confirmedCells")).size()==2&&scene.moves.size()==1,"Preserve partial server evidence through one bounded recovery");
  BuildTaskSmoke.check(scene.builds.getFirst().stopped,"Release the stuck builder before another movement owner");
  var blocked=new BuildTaskSmoke.Scene(){
   public TaskRuntime.Work build(List<SparseBuild.Cell> cells){var child=new BuildTaskSmoke.Work(TaskRuntime.Step.failed("build_blocked"));builds.add(child);return child;}
  };
  blocked.visible.add(a);var stuck=new BuildTask(List.of(a),blocked);stuck.start();var stopped=BuildTaskSmoke.finish(stuck);
  BuildTaskSmoke.check(stopped.state().equals("failed")&&stopped.reason().equals("build_blocked")&&blocked.moves.size()==5,"Permanent obstruction must exhaust bounded approaches and retain its actual cause");
  BuildTaskSmoke.check(blocked.builds.size()==6&&blocked.builds.stream().allMatch(child->child.stopped),"No unbounded stuck-building loop or retained child owner");
  for(String reason:List.of("server_confirmation_missing","materials_missing","build_target_occupied","build_incomplete")){
   var terminal=new BuildTaskSmoke.Scene(){public TaskRuntime.Work build(List<SparseBuild.Cell> cells){return new BuildTaskSmoke.Work(TaskRuntime.Step.failed(reason));}};
   terminal.visible.add(a);var denied=new BuildTask(List.of(a),terminal);denied.start();var failure=BuildTaskSmoke.finish(denied);
   BuildTaskSmoke.check(failure.state().equals("failed")&&failure.reason().equals(reason)&&terminal.moves.isEmpty(),"Recovery must not retry uncertain, missing-material or occupied-target failure: "+reason);
  }
 }
}
