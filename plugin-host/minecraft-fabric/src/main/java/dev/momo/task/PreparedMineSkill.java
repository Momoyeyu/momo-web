package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;
/** One shared mining body for explicit mining and gather's protected mining. */
final class PreparedMineSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();private final JsonObject args;private final boolean protectSupport;
 private TaskRuntime.Work mine,prepare;private Map<String,Object> preparation=Map.of();
 PreparedMineSkill(JsonObject args,boolean protectSupport){this.args=args.deepCopy();this.protectSupport=protectSupport;}
 public void start(){
  int selected=c.player==null?0:c.player.getInventory().selectedSlot;
  mine=GameSkills.rawMine(args,protectSupport);mine.start(); // Validate actual sight/world before inspecting the requested block.
  var pos=new BlockPos(args.get("x").getAsInt(),args.get("y").getAsInt(),args.get("z").getAsInt());var state=c.world.getBlockState(pos);
  var tools=new ArrayList<MiningToolChoice.Tool>();
  for(int i=0;i<36;i++){var stack=c.player.getInventory().getStack(i);if(!stack.isEmpty())tools.add(new MiningToolChoice.Tool(i,stack.isSuitableFor(state),stack.getMiningSpeedMultiplier(state)));}
  boolean required=state.isToolRequired()&&!c.player.getAbilities().creativeMode;
  var chosen=MiningToolChoice.choose(tools,required,selected);
  if(chosen.isEmpty()&&required)throw new TaskRuntime.Rejected("tool_required");
  if(chosen.isPresent()){
   var select=new JsonObject();select.addProperty("item",Registries.ITEM.getId(c.player.getInventory().getStack(chosen.getAsInt()).getItem()).toString());
   mine.stop();prepare=GameSkills.create("selectItem",select);prepare.start();
  }else if(c.currentScreen!=null){mine.stop();prepare=GameSkills.create("closeScreen",new JsonObject());prepare.start();}
 }
 public TaskRuntime.Step tick(){
  if(prepare!=null){var result=prepare.tick();if(!result.state().equals("succeeded"))return result;preparation=result.evidence();prepare.stop();prepare=null;mine.start();}
  var result=mine.tick();
  if(result.state().equals("succeeded")&&!preparation.isEmpty()){var proof=new LinkedHashMap<>(result.evidence());proof.put("toolPreparation",preparation);return TaskRuntime.Step.done(proof);}
  return result;
 }
 public void pause(){if(prepare!=null)prepare.pause();else if(mine!=null)mine.pause();}
 public void resume(){if(prepare!=null)prepare.resume();else if(mine!=null)mine.resume();}
 public void stop(){if(prepare!=null)prepare.stop();if(mine!=null)mine.stop();}
 public boolean acceptsScreen(Object screen){return prepare!=null?prepare.acceptsScreen(screen):mine!=null&&mine.acceptsScreen(screen);}
 public boolean controlsMining(){return prepare==null&&mine!=null&&mine.controlsMining();}
 public boolean retrySafe(String reason){return Set.of("target_not_visible","outside_known_terrain","block_change_rejected").contains(reason);}
 public Map<String,Object> progress(){return Map.of("skill","mine","phase",prepare!=null?"prepare_tool":"mine");}
 public Map<String,Object> partialEvidence(){var proof=new LinkedHashMap<String,Object>();if(!preparation.isEmpty())proof.put("toolPreparation",preparation);if(prepare!=null)proof.putAll(prepare.partialEvidence());else if(mine!=null)proof.putAll(mine.partialEvidence());return Map.copyOf(proof);}
}
