package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.recipe.CraftingRecipe;
import net.minecraft.recipe.RecipeMatcher;
import net.minecraft.item.Items;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;

/** Prefer a visible station, otherwise place one owned table for a real 3x3 recipe. */
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
  return new WorkbenchPreparation(new FindWorkbench(),()->placeOwned(args),GameCraftPreparation::open);
 }
 private static TaskRuntime.Work placeOwned(JsonObject args){
  var c=MinecraftClient.getInstance();boolean owned=false;
  for(int i=0;i<c.player.getInventory().size();i++)if(c.player.getInventory().getStack(i).isOf(Items.CRAFTING_TABLE)){owned=true;break;}
  if(!owned)return null;
  var item=new JsonObject();item.addProperty("item","minecraft:crafting_table");
  return new NearbyPlacementSkill(item,()->remainingIngredients(args));
 }
 private static void remainingIngredients(JsonObject args){
  var c=MinecraftClient.getInstance();
  if(!c.player.getMainHandStack().isOf(Items.CRAFTING_TABLE))throw new TaskRuntime.Rejected("station_required");
  var recipe=c.world.getRecipeManager().get(Identifier.of(args.get("recipe").getAsString())).orElseThrow(()->new TaskRuntime.Rejected("recipe_unknown"));
  if(!c.player.getRecipeBook().contains(recipe)||!(recipe.value() instanceof CraftingRecipe))throw new TaskRuntime.Rejected("recipe_unknown");
  var output=recipe.value().getResult(c.world.getRegistryManager());if(output.isEmpty())throw new TaskRuntime.Rejected("recipe_unknown");
  var matcher=new RecipeMatcher();
  for(int i=0;i<c.player.getInventory().main.size();i++){
   var stack=c.player.getInventory().main.get(i).copy();
   if(i==c.player.getInventory().selectedSlot)stack.decrement(1);
   matcher.addUnenchantedInput(stack);
  }
  int crafts=(args.get("count").getAsInt()+output.getCount()-1)/output.getCount();
  if(!matcher.match(recipe.value(),null,crafts))throw new TaskRuntime.Rejected("materials_missing");
 }
 private static TaskRuntime.Work open(Map<String,Object> point){
  var c=MinecraftClient.getInstance();int x=((Number)point.get("x")).intValue(),y=((Number)point.get("y")).intValue(),z=((Number)point.get("z")).intValue();
  if(!c.world.getBlockState(new BlockPos(x,y,z)).isOf(Blocks.CRAFTING_TABLE))throw new TaskRuntime.Rejected("station_required");
  var args=new JsonObject();args.addProperty("x",x);args.addProperty("y",y);args.addProperty("z",z);return GameSkills.create("interactBlock",args);
 }
 private static final class FindWorkbench implements TaskRuntime.Work {
  private final MinecraftClient c=MinecraftClient.getInstance();
  private List<BlockPos> candidates=List.of();private int index;private boolean paused,closed=true;
  public void start(){
   closed=paused=false;index=0;
   if(c.currentScreen instanceof InventoryScreen)c.player.closeHandledScreen();
   var origin=c.player.getBlockPos();var points=new ArrayList<BlockPos>();
   for(var pos:BlockPos.iterate(origin.add(-6,-3,-6),origin.add(6,3,6)))points.add(pos.toImmutable());
   points.sort(Comparator.comparingDouble(pos->pos.toCenterPos().squaredDistanceTo(c.player.getEyePos())));candidates=points;
  }
  public TaskRuntime.Step tick(){
   if(closed)return TaskRuntime.Step.failed("activity_ended");if(paused)return TaskRuntime.Step.running();
   int budget=16;
   while(index<candidates.size()&&budget-->0){
    var pos=candidates.get(index++);
    if(pos.toCenterPos().squaredDistanceTo(c.player.getEyePos())>36||!c.world.isChunkLoaded(pos)||!c.world.getBlockState(pos).isOf(Blocks.CRAFTING_TABLE)||BlockSight.hit(c,pos)==null)continue;
    return TaskRuntime.Step.done(Map.of("x",pos.getX(),"y",pos.getY(),"z",pos.getZ()));
   }
   return index>=candidates.size()?TaskRuntime.Step.failed("station_required"):TaskRuntime.Step.running();
  }
  public void pause(){paused=true;}public void resume(){paused=false;}public void stop(){closed=true;}
  public Map<String,Object> progress(){return Map.of("skill","craft","phase","find_workbench","checked",index);}
 }
}
