package dev.momo.task;
import java.util.*;
/** The game boundary is replaced; scheduling, receipt checks and takeover are real. */
public final class BuildClearanceSmoke {
 static final SparseBuild.Cell EMPTY=new SparseBuild.Cell(0,65,0,"minecraft:air"),DIG=new SparseBuild.Cell(1,65,0,"minecraft:air"),WALL=new SparseBuild.Cell(2,65,0,"minecraft:dirt");
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static class Scene implements BuildClearance.Scene {
  Map<SparseBuild.Cell,String> states=new HashMap<>(Map.of(EMPTY,"Block{minecraft:cave_air}",DIG,"Block{minecraft:stone}",WALL,"Block{minecraft:air}"));
  List<Body> bodies=new ArrayList<>();List<SparseBuild.Cell> dug=new ArrayList<>();
  boolean hidden,ackOnly,wrongPosition,water,refilled,slow,missing;int placements;
  class Body implements TaskRuntime.Work {
   final SparseBuild.Cell cell;boolean closed,paused;
   Body(SparseBuild.Cell cell){this.cell=cell;}
   public void start(){check(bodies.stream().allMatch(b->b==this||b.closed),"The next physical action started before the previous owner released control");}
   public TaskRuntime.Step tick(){
    if(slow)return TaskRuntime.Step.running();
    if(cell==null){if(missing)return TaskRuntime.Step.failed("materials_missing");placements++;states.put(WALL,"Block{minecraft:dirt}");return TaskRuntime.Step.done(Map.of("confirmedCells",List.of(Map.of("x",2,"y",65,"z",0,"block","Block{minecraft:dirt}","serverBlockSeq",9L))));}
    dug.add(cell);states.put(cell,water?"Block{minecraft:water}":refilled?"Block{minecraft:stone}":"Block{minecraft:air}");
    return TaskRuntime.Step.done(ackOnly?Map.of("accepted",true):Map.of("x",wrongPosition?9:1,"y",65,"z",0,"block","Block{minecraft:stone}","after",water?"Block{minecraft:water}":"Block{minecraft:air}","serverBlockSeq",8L));
   }
   public void pause(){paused=true;}public void resume(){paused=false;}public void stop(){closed=true;}
   public boolean controlsMining(){return cell!=null&&!closed&&!paused;}
   public Map<String,Object> partialEvidence(){return cell==null&&missing?Map.of("missingMaterials",List.of(Map.of("item","minecraft:dirt","missing",1))):Map.of();}
  }
  public String observe(SparseBuild.Cell cell){if(hidden)throw new TaskRuntime.Rejected("build_cells_not_visible");return states.get(cell);}
  public TaskRuntime.Work clear(SparseBuild.Cell cell){check(cell.equals(DIG),"Only the named occupied air cell may be mined");var body=new Body(cell);bodies.add(body);return body;}
  public TaskRuntime.Work place(List<SparseBuild.Cell> cells){check(cells.equals(List.of(WALL)),"Air is an excavation target, never a placement material");var body=new Body(null);bodies.add(body);return body;}
 }
 static TaskRuntime.Step finish(BuildClearance work){for(int i=0;i<12;i++){var step=work.tick();if(!step.state().equals("running"))return step;}throw new AssertionError("Clearance did not settle");}
 public static void main(String[] args){
  var scene=new Scene();var work=new BuildClearance(List.of(EMPTY,DIG,WALL),scene);work.start();var result=finish(work);
  check(result.state().equals("succeeded")&&scene.dug.equals(List.of(DIG))&&scene.placements==1,"Clear existing air, actually mine the named obstruction, then place in one task");
  var proofs=(List<?>)result.evidence().get("confirmedCells");check(proofs.size()==3,"Keep all clearance and placement outcomes");
  var first=(Map<?,?>)proofs.getFirst();var second=(Map<?,?>)proofs.get(1);
  check(Boolean.TRUE.equals(first.get("observedExisting"))&&!first.containsKey("serverBlockSeq"),"Existing air is observed, not a fictitious mined block");
  check(second.get("serverBlockSeq").equals(8L)&&!second.containsKey("observedExisting"),"New clearance requires its actual mining receipt");
  for(int bad=0;bad<4;bad++){
   scene=new Scene();scene.ackOnly=bad==0;scene.wrongPosition=bad==1;scene.water=bad==2;scene.refilled=bad==3;
   work=new BuildClearance(List.of(DIG,WALL),scene);work.start();result=finish(work);
   check(result.state().equals("failed")&&result.reason().equals("unverified_result")&&scene.placements==0,"Never place after an acknowledgement, wrong coordinate, water replacement or reoccupied cell");work.stop();
   check(scene.bodies.stream().allMatch(b->b.closed),"A rejected completion releases its body");
  }
  scene=new Scene();scene.hidden=true;work=new BuildClearance(List.of(DIG,WALL),scene);work.start();
  try{work.tick();throw new AssertionError("Hidden clearance was treated as known");}catch(TaskRuntime.Rejected expected){check(scene.bodies.isEmpty(),"No physical action before actual sight");}finally{work.stop();}
  scene=new Scene();scene.slow=true;work=new BuildClearance(List.of(EMPTY,DIG,WALL),scene);work.start();work.tick();work.tick();
  check(work.controlsMining(),"Clearance owns the actual mining body");work.pause();check(!work.controlsMining()&&scene.bodies.getFirst().paused,"Pause releases active breaking");work.tick();check(scene.placements==0,"Paused clearance cannot place");
  work.resume();work.stop();work.resume();check(work.tick().reason().equals("activity_ended")&&scene.placements==0&&scene.bodies.getFirst().closed,"A late tick or resume cannot restart stopped clearance");
  check(((List<?>)work.partialEvidence().get("confirmedCells")).size()==1,"Cancellation retains the air that really was observed");
  scene=new Scene();scene.missing=true;work=new BuildClearance(List.of(DIG,WALL),scene);work.start();result=finish(work);
  check(result.reason().equals("materials_missing")&&((List<?>)work.partialEvidence().get("confirmedCells")).size()==1&&work.partialEvidence().containsKey("missingMaterials"),"A placement failure retains completed excavation and the real material shortage");work.stop();
  System.out.println("PASS explicit clearance, actual air receipts, single body ownership and stop");
 }
}
