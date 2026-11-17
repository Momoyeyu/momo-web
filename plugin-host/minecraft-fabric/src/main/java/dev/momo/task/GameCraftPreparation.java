package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.recipe.CraftingRecipe;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;

/** Uses only a nearby actually visible workbench; never creates a station or a recipe. */
final class GameCraftPreparation {
 static TaskRuntime.Work create(JsonObject args){
  var owned=args.deepCopy();return new PreparedCraftSkill(()->prepare(owned),()->GameSkills.rawCraft(owned));
 }
 private static TaskRuntime.Work prepare(JsonObject args){
  var c=MinecraftClient.getInstance();if(c.world==null||c.player==null)throw new TaskRuntime.Rejected("world_unavailable");
  var recipe=c.world.getRecipeManager().get(Identifier.of(args.get("recipe").getAsString())).orElseThrow(()->new TaskRuntime.Rejected("recipe_unknown"));
  if(!c.player.getRecipeBook().contains(recipe))throw new TaskRuntime.Rejected("recipe_unknown");
  if(!(recipe.value() instanceof CraftingRecipe crafting)||c.player.currentScreenHandler instanceof CraftingScreenHandler)return null;
  if(!(c.player.currentScreenHandler instanceof PlayerScreenHandler)||c.currentScreen!=null&&!(c.currentScreen instanceof InventoryScreen))throw new TaskRuntime.Rejected("station_required");
  if(crafting.fits(2,2)||!crafting.fits(3,3))return null;
  if(!c.player.currentScreenHandler.getCursorStack().isEmpty())throw new TaskRuntime.Rejected("cursor_not_empty");
  return new FindWorkbench();
 }
 private static final class FindWorkbench implements TaskRuntime.Work {
  private final MinecraftClient c=MinecraftClient.getInstance();
  private List<BlockPos> candidates=List.of();private int index;private TaskRuntime.Work opening;private boolean paused,closed=true;
  public void start(){
   closed=paused=false;index=0;opening=null;
   if(c.currentScreen instanceof InventoryScreen)c.player.closeHandledScreen();
   var origin=c.player.getBlockPos();var points=new ArrayList<BlockPos>();
   for(var pos:BlockPos.iterate(origin.add(-6,-3,-6),origin.add(6,3,6)))points.add(pos.toImmutable());
   points.sort(Comparator.comparingDouble(pos->pos.toCenterPos().squaredDistanceTo(c.player.getEyePos())));candidates=points;
  }
  public TaskRuntime.Step tick(){
   if(closed)return TaskRuntime.Step.failed("activity_ended");if(paused)return TaskRuntime.Step.running();
   if(opening!=null)return opening.tick();
   int budget=16;
   while(index<candidates.size()&&budget-->0){
    var pos=candidates.get(index++);
    if(pos.toCenterPos().squaredDistanceTo(c.player.getEyePos())>36||!c.world.isChunkLoaded(pos)||!c.world.getBlockState(pos).isOf(Blocks.CRAFTING_TABLE)||BlockSight.hit(c,pos)==null)continue;
    var args=new JsonObject();args.addProperty("x",pos.getX());args.addProperty("y",pos.getY());args.addProperty("z",pos.getZ());
    opening=GameSkills.create("interactBlock",args);opening.start();return TaskRuntime.Step.running();
   }
   return index>=candidates.size()?TaskRuntime.Step.failed("station_required"):TaskRuntime.Step.running();
  }
  public void pause(){if(!closed){paused=true;if(opening!=null)opening.pause();}}
  public void resume(){if(!closed){paused=false;if(opening!=null)opening.resume();}}
  public void stop(){closed=true;if(opening!=null)opening.stop();}
  public boolean acceptsScreen(Object screen){return !closed&&opening!=null&&opening.acceptsScreen(screen);}
  public Map<String,Object> progress(){return Map.of("skill","craft","phase","find_workbench","checked",index);}
  public Map<String,Object> partialEvidence(){return opening==null?Map.of():opening.partialEvidence();}
 }
}
