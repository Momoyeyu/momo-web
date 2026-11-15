package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;
/** Preparation never restarts the mining body or replaces its original receipt boundary. */
final class PreparedMineSkill implements TaskRuntime.Work {
 private final TaskRuntime.Work mine;private final Supplier<TaskRuntime.Work> prepareTool;private final BooleanSupplier suitable;
 private TaskRuntime.Work prepare;private final List<Map<String,Object>> preparations=new ArrayList<>();
 private boolean started,paused,closed;
 PreparedMineSkill(TaskRuntime.Work mine,Supplier<TaskRuntime.Work> prepareTool,BooleanSupplier suitable){this.mine=mine;this.prepareTool=prepareTool;this.suitable=suitable;}
 static TaskRuntime.Work create(JsonObject args,boolean protectSupport){
  var owned=args.deepCopy();var pos=new BlockPos(owned.get("x").getAsInt(),owned.get("y").getAsInt(),owned.get("z").getAsInt());
  return new PreparedMineSkill(GameSkills.rawMine(owned,protectSupport),()->prepare(pos),()->heldSuitable(MinecraftClient.getInstance(),pos));
 }
 static boolean heldSuitable(MinecraftClient c,BlockPos pos){
  if(c.player==null||c.world==null)return false;
  var state=c.world.getBlockState(pos);
  return c.player.getAbilities().creativeMode||!state.isToolRequired()||c.player.getMainHandStack().isSuitableFor(state);
 }
 private static TaskRuntime.Work prepare(BlockPos pos){
  var c=MinecraftClient.getInstance();if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");
  if(BlockSight.hit(c,pos)==null)throw new TaskRuntime.Rejected("target_not_visible");
  var state=c.world.getBlockState(pos);int selected=c.player.getInventory().selectedSlot;
  var tools=new ArrayList<MiningToolChoice.Tool>();
  for(int i=0;i<36;i++){var stack=c.player.getInventory().getStack(i);if(!stack.isEmpty())tools.add(new MiningToolChoice.Tool(i,stack.isSuitableFor(state),stack.getMiningSpeedMultiplier(state)));}
  boolean required=state.isToolRequired()&&!c.player.getAbilities().creativeMode;
  var chosen=MiningToolChoice.choose(tools,required,selected);
  if(chosen.isEmpty()&&required)throw new TaskRuntime.Rejected("tool_required");
  if(chosen.isPresent()&&chosen.getAsInt()!=selected){
   var select=new JsonObject();select.addProperty("item",Registries.ITEM.getId(c.player.getInventory().getStack(chosen.getAsInt()).getItem()).toString());
   if(chosen.getAsInt()<9)select.addProperty("hotbar",chosen.getAsInt());
   return GameSkills.create("selectItem",select);
  }
  return c.currentScreen==null?null:GameSkills.create("closeScreen",new JsonObject());
 }
 public void start(){closed=false;paused=false;prepare=null;started=true;mine.start();beginPreparation();} // A new declared attempt validates sight before selecting a tool.
 private void beginPreparation(){
  if(!paused){mine.pause();paused=true;}
  prepare=prepareTool.get();
  if(prepare!=null)prepare.start();
  else if(!suitable.getAsBoolean())throw new TaskRuntime.Rejected("tool_required");
  else{mine.resume();paused=false;}
 }
 public TaskRuntime.Step tick(){
  if(prepare==null&&!suitable.getAsBoolean())beginPreparation();
  if(prepare!=null){
   var result=prepare.tick();if(!result.state().equals("succeeded"))return result;
   preparations.add(result.evidence());prepare.stop();prepare=null;
   if(!suitable.getAsBoolean())return TaskRuntime.Step.failed("tool_required");
   mine.resume();paused=false;
  }
  var result=mine.tick();
  if(result.state().equals("succeeded")&&!preparations.isEmpty()){var proof=new LinkedHashMap<>(result.evidence());proof.putAll(preparationEvidence());return TaskRuntime.Step.done(proof);}
  return result;
 }
 public void pause(){if(prepare!=null)prepare.pause();else if(started){mine.pause();paused=true;}}
 public void resume(){if(prepare!=null)prepare.resume();else if(started)beginPreparation();}
 public void stop(){if(closed)return;closed=true;if(prepare!=null)prepare.stop();if(started)mine.stop();}
 public boolean acceptsScreen(Object screen){return prepare!=null?prepare.acceptsScreen(screen):started&&mine.acceptsScreen(screen);}
 public boolean controlsMining(){return !closed&&!paused&&prepare==null&&started&&mine.controlsMining();}
 public boolean retrySafe(String reason){return Set.of("target_not_visible","outside_known_terrain","block_change_rejected").contains(reason);}
 public Map<String,Object> progress(){return Map.of("skill","mine","phase",prepare!=null?"prepare_tool":"mine");}
 private Map<String,Object> preparationEvidence(){
  if(preparations.isEmpty())return Map.of();
  var proof=new LinkedHashMap<String,Object>();proof.put("toolPreparation",preparations.getLast());
  if(preparations.size()>1)proof.put("toolPreparations",List.copyOf(preparations));return proof;
 }
 public Map<String,Object> partialEvidence(){
  var proof=new LinkedHashMap<String,Object>(preparationEvidence());
  if(prepare!=null)proof.putAll(prepare.partialEvidence());else if(started)proof.putAll(mine.partialEvidence());return Map.copyOf(proof);
 }
}
