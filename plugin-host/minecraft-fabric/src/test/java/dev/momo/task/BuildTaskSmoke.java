package dev.momo.task;
import java.util.*;
/** A blueprint is intent: unseen cells need observation, never blind mutation. */
public final class BuildTaskSmoke {
 static final SparseBuild.Cell A=new SparseBuild.Cell(0,66,0,"minecraft:dirt"),B=new SparseBuild.Cell(1,66,0,"minecraft:dirt");
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static class Work implements TaskRuntime.Work {
  boolean started,stopped,paused;TaskRuntime.Step result;Runnable complete=()->{};
  Work(TaskRuntime.Step result){this.result=result;}
  public void start(){started=true;}public TaskRuntime.Step tick(){complete.run();return result;}
  public void stop(){stopped=true;}public void pause(){paused=true;}public void resume(){paused=false;}
  public boolean acceptsScreen(Object screen){return "owned".equals(screen);}
 }
 static class Scene implements BuildTask.Scene {
  Set<SparseBuild.Cell> visible=new HashSet<>(),placed=new HashSet<>();List<Work> builds=new ArrayList<>(),moves=new ArrayList<>();boolean valid=true,reveal=true,ackOnly,removeOnMove,rejectFirstStart,rejectFirstTick;
  public void start(){}public void check(){if(!valid)throw new TaskRuntime.Rejected("world_unavailable");}
  public List<SparseBuild.Cell> visible(List<SparseBuild.Cell> cells){return cells.stream().filter(visible::contains).toList();}
  public boolean matches(SparseBuild.Cell cell){return placed.contains(cell);}
  public TaskRuntime.Work build(List<SparseBuild.Cell> cells){
   BuildTaskSmoke.check(visible.containsAll(cells),"Never build an unseen cell");
   var proof=cells.stream().map(c->Map.<String,Object>of("x",c.x(),"y",c.y(),"z",c.z(),"block","Block{"+c.block()+"}",placed.contains(c)?"observedExisting":"serverBlockSeq",placed.contains(c)?Boolean.TRUE:1L)).toList();
   var work=new Work(TaskRuntime.Step.done(ackOnly?Map.of("accepted",true):Map.of("confirmedCells",proof)));
   if(rejectFirstStart&&builds.isEmpty())work=new Work(work.result){public void start(){super.start();throw new TaskRuntime.Rejected("build_cells_not_visible");}};
   if(rejectFirstTick&&builds.isEmpty())work=new Work(work.result){public TaskRuntime.Step tick(){throw new TaskRuntime.Rejected("build_cells_not_visible");}};
   work.complete=()->{if(!ackOnly)placed.addAll(cells);};builds.add(work);return work;
  }
  public TaskRuntime.Work approach(int attempt){
   if(attempt>=5)return null;
   var work=new Work(TaskRuntime.Step.done(Map.of("arrived",true)));work.complete=()->{if(removeOnMove)placed.remove(A);if(reveal)visible.add(B);};moves.add(work);return work;
  }
 }
 static TaskRuntime.Step finish(BuildTask work){TaskRuntime.Step row=null;for(int i=0;i<30;i++){row=work.tick();if(!row.state().equals("running"))return row;}throw new AssertionError("Build did not finish");}
 public static void main(String[] args){
  BuildRecoverySmoke.run();
  var empty=new SparseBuild.Cell(0,66,0,"minecraft:air");
  var airScene=new Scene(){public TaskRuntime.Work build(List<SparseBuild.Cell> cells){
   return new Work(TaskRuntime.Step.done(Map.of("confirmedCells",List.of(Map.of("x",0,"y",66,"z",0,"block","Block{minecraft:cave_air}","observedExisting",true))))){public TaskRuntime.Step tick(){placed.add(empty);return super.tick();}public boolean controlsMining(){return true;}};
  }};
  airScene.visible.add(empty);var clearance=new BuildTask(List.of(empty),airScene);clearance.start();clearance.tick();
  check(clearance.controlsMining(),"Clearance mining must suppress duplicate vanilla breaking through the parent body");
  clearance.pause();check(!clearance.controlsMining(),"A paused build must not claim a live mining body");clearance.resume();
  check(finish(clearance).state().equals("succeeded"),"Explicit air clearance accepts observed cave air rather than falsely requiring a placed air item");
  clearance.stop();check(!clearance.controlsMining(),"Stopped clearance cannot retain mining control");
  var scene=new Scene();scene.visible.add(A);var work=new BuildTask(List.of(A,B),scene);work.start();
  var row=finish(work);check(row.state().equals("succeeded"),"Visible subset then approach must finish the same task");
  check(scene.builds.size()==2&&scene.moves.size()==1,"Only missing cells need another observed batch");
  check(scene.builds.stream().allMatch(w->w.stopped)&&scene.moves.getFirst().stopped,"Release each child before another body owner");
  check(((List<?>)row.evidence().get("confirmedCells")).size()==2,"All cells require actual completion evidence");
  scene=new Scene();scene.visible.add(A);scene.rejectFirstStart=true;work=new BuildTask(List.of(A),scene);work.start();
  check(finish(work).state().equals("succeeded")&&scene.moves.size()==1,"A changed sight preflight needs a bounded approach, not a terminal parent failure");
  scene=new Scene();scene.visible.add(A);scene.rejectFirstTick=true;work=new BuildTask(List.of(A),scene);work.start();
  check(finish(work).state().equals("succeeded")&&scene.moves.size()==1&&scene.builds.getFirst().stopped,"Sight lost during a child tick must use the same bounded approach and release as a returned visibility failure");
  var uncertain=new Scene(){public TaskRuntime.Work build(List<SparseBuild.Cell> cells){return new Work(TaskRuntime.Step.running()){public TaskRuntime.Step tick(){throw new TaskRuntime.Rejected("server_confirmation_missing");}};}};
  uncertain.visible.add(A);var uncertainWork=new BuildTask(List.of(A),uncertain);uncertainWork.start();
  var uncertainResult=finish(uncertainWork);check(uncertainResult.state().equals("failed")&&uncertainResult.reason().equals("server_confirmation_missing")&&uncertain.moves.isEmpty(),"Uncertain mutations remain terminal; visibility recovery must not replay an unconfirmed world change");
  scene=new Scene();scene.visible.add(A);scene.placed.add(A);work=new BuildTask(List.of(A),scene);work.start();
  check(((Number)finish(work).evidence().get("observedExisting")).intValue()==1,"Existing blocks remain observations, not newly built receipts");
  scene=new Scene();scene.visible.add(A);scene.removeOnMove=true;work=new BuildTask(List.of(A,B),scene);work.start();
  check(finish(work).state().equals("succeeded")&&scene.placed.containsAll(List.of(A,B)),"Recheck prior cells after approaching; old receipts cannot conceal a destroyed part");
  scene=new Scene();scene.visible.add(A);scene.ackOnly=true;work=new BuildTask(List.of(A),scene);
  var runtime=new TaskRuntime();runtime.submit("ack-only","build",work,0,10000);runtime.tick(0);runtime.tick(50);
  check(runtime.snapshot("ack-only").state().equals("failed")&&runtime.snapshot("ack-only").reason().equals("unverified_result"),"An accepted child is not a completed blueprint");
  check(scene.builds.getFirst().stopped,"A rejected completion must still release the physical child");
  scene=new Scene();scene.reveal=false;work=new BuildTask(List.of(B),scene);work.start();
  check(finish(work).state().equals("failed")&&scene.moves.size()<=5,"Unknown cells must stop after bounded approaches");
  check(scene.builds.isEmpty(),"No approach grants knowledge of hidden cells by itself");
  scene=new Scene();work=new BuildTask(List.of(B),scene);work.start();work.tick();var move=scene.moves.getFirst();
  work.pause();check(move.paused,"Pause the current physical child");work.tick();check(scene.builds.isEmpty(),"Paused work cannot move to another stage");
  work.resume();check(!move.paused,"Resume the same child without replay");work.stop();check(move.stopped,"Stop releases active navigation");
  work.tick();check(scene.builds.isEmpty(),"A late path result cannot restart a stopped build");
  scene=new Scene();scene.visible.add(A);work=new BuildTask(List.of(A),scene);work.start();work.tick();scene.valid=false;
  try{work.tick();throw new AssertionError("A changed scene must revoke continuation");}catch(TaskRuntime.Rejected expected){work.stop();}
  // A failed child must retain the observed cause as well as completed cells.
  for(String diagnostic:List.of("blockedCells","missingMaterials")){
   var detail=diagnostic.equals("blockedCells")?Map.<String,Object>of("x",0,"y",66,"z",0,"requested","minecraft:dirt","actual","minecraft:stone"):Map.<String,Object>of("item","minecraft:dirt","required",2,"available",0,"missing",2);
   var supplied=List.of(detail);
   var failedScene=new Scene(){
    public TaskRuntime.Work build(List<SparseBuild.Cell> cells){return new Work(TaskRuntime.Step.failed("build_target_occupied")){
     public Map<String,Object> partialEvidence(){return Map.of(diagnostic,supplied);}
    };}
   };
   failedScene.visible.add(A);var failed=new BuildTask(List.of(A),failedScene);
   var jobs=new TaskRuntime();jobs.submit("diagnostic","build",failed,0,10000);jobs.tick(0);jobs.tick(50);
   check(jobs.snapshot("diagnostic").evidence().get(diagnostic)!=null&&jobs.snapshot("diagnostic").evidence().get(diagnostic).equals(supplied),"Preserve the actual child diagnostic through task failure and child release: "+diagnostic);
  }
 }
}
