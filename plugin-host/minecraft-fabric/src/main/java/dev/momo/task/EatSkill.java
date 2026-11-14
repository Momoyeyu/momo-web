package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Map;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
/** Prepare food with the existing verified inventory skill, then consume normally. */
final class EatSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();
 private TaskRuntime.Work work;private int foodBefore,selectedBefore;
 public void start(){
  if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");
  int slot=FoodInventory.find(c,36);if(slot<0)throw new TaskRuntime.Rejected("safe_food_missing");
  var food=c.player.getInventory().getStack(slot).get(DataComponentTypes.FOOD);
  if(!c.player.canConsume(food.canAlwaysEat()))throw new TaskRuntime.Rejected("not_hungry");
  if(c.player.currentScreenHandler!=c.player.playerScreenHandler)throw new TaskRuntime.Rejected("close_station_first");
  foodBefore=c.player.getHungerManager().getFoodLevel();selectedBefore=c.player.getInventory().selectedSlot;
  var steps=new ArrayList<TaskPlan.Node>();int hotbar=-1;boolean restore=false;
  if(slot>=9){
   var empty=new ArrayList<Integer>();for(int i=0;i<9;i++)if(c.player.getInventory().getStack(i).isEmpty())empty.add(i);
   hotbar=FoodChoice.hotbarDestination(empty,selectedBefore);restore=!c.player.getInventory().getStack(hotbar).isEmpty();
   steps.add(node(swap(slot,hotbar)));steps.add(node(GameSkills.create("closeScreen",new JsonObject())));
  }else if(c.currentScreen!=null)steps.add(node(GameSkills.create("closeScreen",new JsonObject())));
  steps.add(node(GameSkills.consumeFood()));
  if(restore){steps.add(node(swap(slot,hotbar)));steps.add(node(GameSkills.create("closeScreen",new JsonObject())));}
  work=steps.size()==1?steps.getFirst().work():new TaskPlan(steps);
  work.start();
 }
 public TaskRuntime.Step tick(){
  var result=work.tick();
  if(result.state().equals("succeeded"))c.player.getInventory().selectedSlot=selectedBefore;
  return result.state().equals("succeeded")?TaskRuntime.Step.done(Map.of("foodBefore",foodBefore,"foodAfter",c.player.getHungerManager().getFoodLevel(),"consumption",result.evidence())):result;
 }
 private static TaskPlan.Node node(TaskRuntime.Work work){return new TaskPlan.Node(work,()->true,0,false);}
 private static TaskRuntime.Work swap(int slot,int hotbar){
  var action=new JsonObject();action.addProperty("slot",slot);action.addProperty("button",hotbar);action.addProperty("mode","swap");
  var actions=new com.google.gson.JsonArray();actions.add(action);
  var inventory=new JsonObject();inventory.addProperty("screen","minecraft:inventory");inventory.add("actions",actions);
  return GameSkills.create("inventory",inventory);
 }
 public boolean handlesEating(){return true;}
 public void pause(){if(work!=null)work.pause();}
 public void resume(){if(work!=null)work.resume();}
 public void stop(){if(work!=null)work.stop();}
 public boolean acceptsScreen(Object screen){return work!=null&&work.acceptsScreen(screen);}
 public Map<String,Object> progress(){return work==null?Map.of("skill","eat","phase","prepare"):Map.of("skill","eat","action",work.progress());}
 public Map<String,Object> partialEvidence(){return work==null?Map.of():work.partialEvidence();}
}
