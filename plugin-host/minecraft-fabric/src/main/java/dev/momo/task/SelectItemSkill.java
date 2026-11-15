package dev.momo.task;
import com.google.gson.*;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.network.packet.c2s.play.UpdateSelectedSlotC2SPacket;
import net.minecraft.registry.Registries;
/** Reuses verified ordinary inventory clicks. Stop never performs a cleanup click. */
final class SelectItemSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();private final String item;private final int preferred;
 private TaskRuntime.Work work;private int phase,hotbar;private final List<Map<String,Object>> receipts=new ArrayList<>();
 SelectItemSkill(JsonObject args){item=SkillArguments.resourceId(args.get("item").getAsString());preferred=args.has("hotbar")?args.get("hotbar").getAsInt():-1;}
 public void start(){
  if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");
  if(c.player.currentScreenHandler!=c.player.playerScreenHandler||c.currentScreen!=null&&!(c.currentScreen instanceof InventoryScreen))throw new TaskRuntime.Rejected("close_station_first");
  if(!c.player.currentScreenHandler.getCursorStack().isEmpty()){
   int empty=-1;for(int i=9;i<45;i++)if(c.player.playerScreenHandler.getSlot(i).getStack().isEmpty()){empty=i;break;}
   if(empty<0)throw new TaskRuntime.Rejected("inventory_full");
   phase=1;begin(click(empty,0,"pickup"));
  }else prepare();
 }
 private void begin(TaskRuntime.Work next){work=next;work.start();}
 private void prepare(){
  var matches=new ArrayList<Integer>();for(int i=0;i<36;i++)if(!c.player.getInventory().getStack(i).isEmpty()&&Registries.ITEM.getId(c.player.getInventory().getStack(i).getItem()).toString().equals(item))matches.add(i);
  var choice=ItemSelection.choose(matches,preferred,c.player.getInventory().selectedSlot).orElseThrow(()->new TaskRuntime.Rejected("item_missing"));hotbar=choice.hotbar();
  if(choice.swap()){phase=2;begin(click(choice.screenSlot(),hotbar,"swap"));}else select();
 }
 private void select(){
  c.player.getInventory().selectedSlot=hotbar;c.player.networkHandler.sendPacket(new UpdateSelectedSlotC2SPacket(hotbar));
  if(c.currentScreen!=null){phase=3;begin(GameSkills.create("closeScreen",new JsonObject()));}else work=null;
 }
 public TaskRuntime.Step tick(){
  if(work!=null){var result=work.tick();if(result.state().equals("failed"))return result;if(result.state().equals("running"))return result;
   receipts.add(result.evidence());work.stop();work=null;if(phase==1)prepare();else if(phase==2)select();
   if(work!=null)return TaskRuntime.Step.running();
  }
  var stack=c.player.getMainHandStack();
  if(c.player.getInventory().selectedSlot!=hotbar||stack.isEmpty()||!Registries.ITEM.getId(stack.getItem()).toString().equals(item))return TaskRuntime.Step.failed("selected_item_changed");
  return TaskRuntime.Step.done(Map.of("item",item,"hotbar",hotbar,"count",stack.getCount(),"inventoryChanges",List.copyOf(receipts)));
 }
 private TaskRuntime.Work click(int slot,int button,String mode){var action=new JsonObject();action.addProperty("slot",slot);action.addProperty("button",button);action.addProperty("mode",mode);var actions=new JsonArray();actions.add(action);var args=new JsonObject();args.addProperty("screen","minecraft:inventory");args.add("actions",actions);return GameSkills.create("inventory",args);}
 public void pause(){if(work!=null)work.pause();}public void resume(){if(work!=null)work.resume();}public void stop(){if(work!=null)work.stop();}
 public boolean acceptsScreen(Object screen){return work!=null&&work.acceptsScreen(screen);}
 public Map<String,Object> progress(){return Map.of("skill","selectItem","phase",phase);}
 public Map<String,Object> partialEvidence(){var facts=new ArrayList<>(receipts);if(work!=null&&!work.partialEvidence().isEmpty())facts.add(work.partialEvidence());return facts.isEmpty()?Map.of():Map.of("inventoryChanges",List.copyOf(facts));}
}
