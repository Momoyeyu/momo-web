package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
/** Prepare food with the existing verified inventory skill, then consume normally. */
final class EatSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();
 private TaskRuntime.Work work;private int foodBefore;
 public void start(){
  if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");
  int slot=FoodInventory.find(c,36);if(slot<0)throw new TaskRuntime.Rejected("safe_food_missing");
  var food=c.player.getInventory().getStack(slot).get(DataComponentTypes.FOOD);
  if(!c.player.canConsume(food.canAlwaysEat()))throw new TaskRuntime.Rejected("not_hungry");
  if(c.player.currentScreenHandler!=c.player.playerScreenHandler)throw new TaskRuntime.Rejected("close_station_first");
  foodBefore=c.player.getHungerManager().getFoodLevel();
  if(slot<9)work=GameSkills.consumeFood();
  else{
   var empty=new ArrayList<Integer>();for(int i=0;i<9;i++)if(c.player.getInventory().getStack(i).isEmpty())empty.add(i);
   int hotbar=FoodChoice.hotbarDestination(empty,c.player.getInventory().selectedSlot);
   var action=new JsonObject();action.addProperty("slot",slot);action.addProperty("button",hotbar);action.addProperty("mode","swap");
   var actions=new com.google.gson.JsonArray();actions.add(action);
   var inventory=new JsonObject();inventory.addProperty("screen","minecraft:inventory");inventory.add("actions",actions);
   work=new TaskPlan(List.of(new TaskPlan.Node(GameSkills.create("inventory",inventory),()->true,0,false),new TaskPlan.Node(GameSkills.create("closeScreen",new JsonObject()),()->true,0,false),new TaskPlan.Node(GameSkills.consumeFood(),()->true,0,false)));
  }
  work.start();
 }
 public TaskRuntime.Step tick(){
  var result=work.tick();
  return result.state().equals("succeeded")?TaskRuntime.Step.done(Map.of("foodBefore",foodBefore,"foodAfter",c.player.getHungerManager().getFoodLevel(),"consumption",result.evidence())):result;
 }
 public void pause(){if(work!=null)work.pause();}
 public void resume(){if(work!=null)work.resume();}
 public void stop(){if(work!=null)work.stop();}
 public boolean acceptsScreen(Object screen){return work!=null&&work.acceptsScreen(screen);}
 public Map<String,Object> progress(){return work==null?Map.of("skill","eat","phase","prepare"):Map.of("skill","eat","action",work.progress());}
 public Map<String,Object> partialEvidence(){return work==null?Map.of():work.partialEvidence();}
}
