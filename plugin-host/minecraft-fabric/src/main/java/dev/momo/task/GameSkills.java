package dev.momo.task;

import com.google.gson.*;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.*;
import net.minecraft.registry.Registries;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.*;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;

/** Typed, bounded vanilla skills. Uses the current player's normal interactions only. */
public final class GameSkills {
 public static final List<String> NAMES=List.copyOf(SkillArguments.contract().keySet());
 private GameSkills(){}
 public static TaskRuntime.Work create(String skill,JsonObject args){
  SkillArguments.validate(skill,args);
  if(skill.equals("plan")){
   var work=new ArrayList<TaskPlan.Node>();
   for(var value:args.getAsJsonArray("steps")){
    var step=value.getAsJsonObject();var condition=step.has("when")?step.getAsJsonObject("when"):null;
    work.add(new TaskPlan.Node(create(step.get("skill").getAsString(),step.getAsJsonObject("args")),()->{
     if(condition==null)return true;var client=MinecraftClient.getInstance();int count=0;
     if(client.player==null)return false;
     for(int i=0;i<client.player.getInventory().size();i++){var stack=client.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(condition.get("item").getAsString()))count+=stack.getCount();}
     return condition.get("test").getAsString().equals("atLeast")?count>=condition.get("count").getAsInt():count<condition.get("count").getAsInt();
    },step.has("retries")?step.get("retries").getAsInt():0,step.has("onFailure")&&step.get("onFailure").getAsString().equals("skip")));
   }
   return new TaskPlan(work);
  }
  return new Skill(skill,args.deepCopy());
 }
 private static void keys(JsonObject a,String names){
  var expected=names.isEmpty()?Set.<String>of():new HashSet<>(Arrays.asList(names.split(",")));
  if(!a.keySet().equals(expected))throw new IllegalArgumentException("Invalid skill arguments");
 }
 private static int integer(JsonObject a,String k,int min,int max){var value=a.get(k);if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw new IllegalArgumentException("Invalid "+k);double d=value.getAsDouble();if(!Double.isFinite(d)||d!=Math.rint(d)||d<min||d>max)throw new IllegalArgumentException("Invalid "+k);return (int)d;}
 private static String string(JsonObject a,String k,int max){var v=a.get(k);if(v==null||!v.isJsonPrimitive()||!v.getAsJsonPrimitive().isString())throw new IllegalArgumentException("Invalid "+k);String s=v.getAsString();if(s.isBlank()||s.length()>max||s.chars().anyMatch(c->c<32))throw new IllegalArgumentException("Invalid "+k);return s;}
 private static Identifier identifier(JsonObject a,String k){return Identifier.of(string(a,k,128));}
 private static BlockPos position(JsonObject a){return new BlockPos(integer(a,"x",-30000000,30000000),integer(a,"y",-64,319),integer(a,"z",-30000000,30000000));}
 private static Direction direction(JsonObject a){var d=Direction.byName(string(a,"face",10));if(d==null)throw new IllegalArgumentException("Invalid face");return d;}
 private static final class Skill implements TaskRuntime.Work {
  final String skill;final JsonObject args;final MinecraftClient c=MinecraftClient.getInstance();
  final BaritoneNavigator navigation=new BaritoneNavigator();
  BlockPos pos,placed,pathTarget,lastSeen;Entity entity;Screen ownedScreen;boolean navigating,startedUse;int ticks,actionIndex,phase,startFood,beforeCount,lostTicks;String beforeState,inventoryBefore,outputItem;float startHealth;int targetSlot;
  Skill(String skill,JsonObject args){this.skill=skill;this.args=args;ownedScreen=c.currentScreen;}
  public void start(){
   if(c.player==null||c.world==null||c.interactionManager==null)throw new IllegalStateException("No world");
   inventoryBefore=inventoryState();startFood=c.player.getHungerManager().getFoodLevel();startHealth=c.player.getHealth();
   ownedScreen=c.currentScreen;
   if(Set.of("navigate","mine","place","interactBlock").contains(skill)){
    pos=position(args);if(!c.world.isChunkLoaded(pos)||c.player.squaredDistanceTo(pos.toCenterPos())>4096)throw new IllegalArgumentException("Outside known local terrain");
    if(!skill.equals("navigate")&&!visible(pos))throw new IllegalArgumentException("Target is not visible");
    beforeState=c.world.getBlockState(pos).toString();
   }
   if(Set.of("follow","interactEntity","attack","pickup").contains(skill)){
    entity=c.world.getEntityById(args.get("entityId").getAsInt());
    if(entity==null||!c.player.canSee(entity)||entity.squaredDistanceTo(c.player)>1024)throw new IllegalArgumentException("Entity is not visible");lastSeen=entity.getBlockPos();
   }
   if(skill.equals("navigate"))go(pos);
   if(skill.equals("mine")&&!c.world.getBlockState(pos).isAir())selectTool();
   if(skill.equals("place")){targetSlot=args.get("slot").getAsInt();placed=pos.offset(direction(args));c.player.getInventory().selectedSlot=targetSlot;if(c.player.getMainHandStack().isEmpty())throw new IllegalArgumentException("Missing material");beforeState=c.world.getBlockState(placed).toString();}
   if(skill.equals("pickup")){
    if(!(entity instanceof net.minecraft.entity.ItemEntity drop))throw new IllegalArgumentException("Not a dropped item");
    outputItem=Registries.ITEM.getId(drop.getStack().getItem()).toString();beforeCount=count(outputItem);
   }
   if(skill.equals("trade")){
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.MerchantScreenHandler merchant))throw new IllegalArgumentException("Open a merchant first");
    int index=args.get("index").getAsInt();if(index>=merchant.getRecipes().size()||merchant.getRecipes().get(index).isDisabled())throw new IllegalArgumentException("Trade unavailable");
    var offer=merchant.getRecipes().get(index);outputItem=Registries.ITEM.getId(offer.getSellItem().getItem()).toString();beforeCount=count(outputItem);targetSlot=offer.getSellItem().getCount()*args.get("count").getAsInt();
    merchant.setRecipeIndex(index);merchant.switchTo(index);c.player.networkHandler.sendPacket(new net.minecraft.network.packet.c2s.play.SelectMerchantTradeC2SPacket(index));
   }
   if(skill.equals("eat")){targetSlot=foodSlot();if(targetSlot<0)throw new IllegalArgumentException("No food");c.player.getInventory().selectedSlot=targetSlot;beforeCount=c.player.getMainHandStack().getCount();}
   if(skill.equals("useItem")){c.player.getInventory().selectedSlot=args.get("slot").getAsInt();beforeCount=c.player.getMainHandStack().getCount();}
   if(skill.equals("inventory")||skill.equals("workstation")){
    if(skill.equals("inventory")&&c.currentScreen==null)c.setScreen(new InventoryScreen(c.player));
    ownedScreen=c.currentScreen;
    if(!screenName().equals(args.get("screen").getAsString()))throw new IllegalArgumentException("Screen changed");
   }
   if(skill.equals("craft")){
    if(c.currentScreen==null)c.setScreen(new InventoryScreen(c.player));ownedScreen=c.currentScreen;
    var recipe=c.world.getRecipeManager().get(identifier(args,"recipe")).orElseThrow(()->new IllegalArgumentException("Unknown recipe"));
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.CraftingScreenHandler||c.player.currentScreenHandler instanceof net.minecraft.screen.PlayerScreenHandler))throw new IllegalArgumentException("Open a crafting station");
    if(!c.player.getRecipeBook().contains(recipe))throw new IllegalArgumentException("Recipe not known to player");
    var output=recipe.value().getResult(c.world.getRegistryManager());outputItem=Registries.ITEM.getId(output.getItem()).toString();beforeCount=count(outputItem);
   }
   if(skill.equals("closeScreen"))c.player.closeHandledScreen();
   if(skill.equals("respawn")){if(c.player.isAlive())throw new IllegalArgumentException("Already alive");c.player.requestRespawn();}
  }
  public TaskRuntime.Step tick(){
   if(++ticks>2400)return TaskRuntime.Step.failed("skill_timeout");
   if(skill.equals("respawn"))return c.player.isAlive()?done(Map.of("alive",true)):TaskRuntime.Step.running();
   if(!c.player.isAlive())return TaskRuntime.Step.failed("dead");
   switch(skill){
    case "navigate":
     if(navigation.arrived())return done(Map.of("x",c.player.getX(),"y",c.player.getY(),"z",c.player.getZ(),"arrived",true));
     if(navigation.failed())return TaskRuntime.Step.failed("unreachable");break;
    case "follow":
     if(!entity.isAlive())return TaskRuntime.Step.failed("target_lost");
     if(!c.player.canSee(entity)){if(++lostTicks>60)return TaskRuntime.Step.failed("target_lost");approach(lastSeen,20);break;}lostTicks=0;lastSeen=entity.getBlockPos();
     if(entity.squaredDistanceTo(c.player)<9){haltNavigation();return done(Map.of("entityId",entity.getId(),"distance",Math.sqrt(entity.squaredDistanceTo(c.player))));}
     approach(entity.getBlockPos(),20);break;
    case "mine":
     if(c.world.getBlockState(pos).isAir()||!c.world.getBlockState(pos).toString().equals(beforeState))return done(Map.of("block",beforeState,"x",pos.getX(),"y",pos.getY(),"z",pos.getZ(),"after",c.world.getBlockState(pos).toString(),"inventory",inventoryState()));
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();look(pos.toCenterPos());
     c.interactionManager.updateBlockBreakingProgress(pos,face(pos));c.player.swingHand(Hand.MAIN_HAND);break;
    case "place":
     if(!c.world.getBlockState(placed).toString().equals(beforeState))return done(Map.of("x",placed.getX(),"y",placed.getY(),"z",placed.getZ(),"block",c.world.getBlockState(placed).toString()));
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
     if(++phase>40)return TaskRuntime.Step.failed("placement_blocked_or_material_missing");
     if(ticks%6==1){var direction=direction(args);var hit=new BlockHitResult(pos.toCenterPos().add(Vec3d.of(direction.getVector()).multiply(.5)),direction,pos,false);look(hit.getPos());c.interactionManager.interactBlock(c.player,Hand.MAIN_HAND,hit);c.player.swingHand(Hand.MAIN_HAND);}break;
    case "interactBlock":
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
     if(phase++==0){look(pos.toCenterPos());c.interactionManager.interactBlock(c.player,Hand.MAIN_HAND,new BlockHitResult(pos.toCenterPos(),face(pos),pos,false));}
     if(ticks>4&&(c.currentScreen!=ownedScreen||!c.world.getBlockState(pos).toString().equals(beforeState)||!inventoryState().equals(inventoryBefore)||c.player.hasVehicle()||c.player.isSleeping()))return done(Map.of("screen",screenName(),"block",c.world.getBlockState(pos).toString(),"riding",c.player.hasVehicle(),"sleeping",c.player.isSleeping()));
     if(phase>80)return TaskRuntime.Step.failed("no_interaction_result");break;
    case "interactEntity":
     if(entity.squaredDistanceTo(c.player)>9){approach(entity.getBlockPos(),20);break;}haltNavigation();
     if(phase++==0){look(entity.getEyePos());c.interactionManager.interactEntity(c.player,entity,Hand.MAIN_HAND);}
     if(ticks>4&&(c.currentScreen!=ownedScreen||c.player.hasVehicle()||!inventoryState().equals(inventoryBefore)))return done(Map.of("entityId",entity.getId(),"screen",screenName(),"riding",c.player.hasVehicle(),"inventory",inventoryState()));
     if(phase>80)return TaskRuntime.Step.failed("no_interaction_result");break;
    case "pickup":
     if(count(outputItem)>beforeCount)return done(Map.of("item",outputItem,"countBefore",beforeCount,"countAfter",count(outputItem)));
     if(entity.isRemoved())return TaskRuntime.Step.failed("drop_gone_without_inventory_gain");
     approach(entity.getBlockPos(),20);break;
    case "waitFor":
     int present=0;
     if(args.get("area").getAsString().equals("inventory"))present=count(args.get("item").getAsString());
     else for(var slot:c.player.currentScreenHandler.slots)if(Registries.ITEM.getId(slot.getStack().getItem()).toString().equals(args.get("item").getAsString()))present+=slot.getStack().getCount();
     if(present>=args.get("count").getAsInt())return done(Map.of("item",args.get("item").getAsString(),"count",present));
     if(ticks>=args.get("ticks").getAsInt())return TaskRuntime.Step.failed("processing_result_timeout");break;
    case "trade":
     if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.MerchantScreenHandler))return TaskRuntime.Step.failed("merchant_closed");
     if(count(outputItem)-beforeCount>=targetSlot)return done(Map.of("item",outputItem,"countBefore",beforeCount,"countAfter",count(outputItem)));
     if(ticks%8==4&&!c.player.currentScreenHandler.getSlot(2).getStack().isEmpty())c.interactionManager.clickSlot(c.player.currentScreenHandler.syncId,2,0,SlotActionType.QUICK_MOVE,c.player);
     if(ticks>100)return TaskRuntime.Step.failed("trade_stock_or_currency_missing");break;
    case "attack": return combat();
    case "eat":
     if(c.player.getHungerManager().getFoodLevel()>startFood||c.player.getMainHandStack().getCount()<beforeCount)return done(Map.of("foodBefore",startFood,"foodAfter",c.player.getHungerManager().getFoodLevel(),"remaining",c.player.getMainHandStack().getCount()));
     if(ticks%4==1&&!c.player.isUsingItem())c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);break;
    case "useItem":
     if(ticks==1)c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);
     if(ticks>=args.get("ticks").getAsInt())return done(Map.of("ticks",ticks,"item",Registries.ITEM.getId(c.player.getMainHandStack().getItem()).toString(),"countBefore",beforeCount,"countAfter",c.player.getMainHandStack().getCount(),"using",c.player.isUsingItem()));break;
    case "inventory","workstation":
     if(!screenName().equals(args.get("screen").getAsString()))return TaskRuntime.Step.failed("screen_changed");
     if(ticks%4==1&&actionIndex<args.getAsJsonArray("actions").size()){
      var a=args.getAsJsonArray("actions").get(actionIndex++).getAsJsonObject();int slot=a.get("slot").getAsInt(),button=a.get("button").getAsInt();String mode=a.get("mode").getAsString();
      if(mode.equals("button"))c.interactionManager.clickButton(c.player.currentScreenHandler.syncId,slot);
      else {if(slot>=c.player.currentScreenHandler.slots.size())return TaskRuntime.Step.failed("slot_missing");c.interactionManager.clickSlot(c.player.currentScreenHandler.syncId,slot,button,switch(mode){case "quickMove"->SlotActionType.QUICK_MOVE;case "swap"->SlotActionType.SWAP;case "throw"->SlotActionType.THROW;default->SlotActionType.PICKUP;},c.player);}
     }
     if(ticks>args.getAsJsonArray("actions").size()*4+4){String after=inventoryState();return after.equals(inventoryBefore)?TaskRuntime.Step.failed("no_inventory_change"):done(Map.of("before",inventoryBefore,"after",after,"screen",screenName()));}break;
    case "craft":
     int gained=count(outputItem)-beforeCount;
     if(gained>=args.get("count").getAsInt())return done(Map.of("item",outputItem,"countBefore",beforeCount,"countAfter",count(outputItem)));
     if(ticks%8==1)c.interactionManager.clickRecipe(c.player.currentScreenHandler.syncId,c.world.getRecipeManager().get(identifier(args,"recipe")).orElseThrow(),false);
     if(ticks%8==5&&!c.player.currentScreenHandler.getSlot(0).getStack().isEmpty())c.interactionManager.clickSlot(c.player.currentScreenHandler.syncId,0,0,SlotActionType.QUICK_MOVE,c.player);
     if(ticks>100&&gained==0)return TaskRuntime.Step.failed("ingredients_or_station_missing");break;
    case "closeScreen":if(c.currentScreen==null)return done(Map.of("screen","world"));break;
    default: return TaskRuntime.Step.failed("unsupported_skill");
   }
   return TaskRuntime.Step.running();
  }
  private TaskRuntime.Step combat(){
   if(!entity.isAlive()||entity.isRemoved())return done(Map.of("entityId",entity.getId(),"targetAlive",false));
   if(!c.player.canSee(entity)||entity.squaredDistanceTo(c.player)>1024)return TaskRuntime.Step.failed("target_lost");
   if(c.player.getHealth()<=6){haltNavigation();look(entity.getEyePos());c.options.backKey.setPressed(true);c.options.sprintKey.setPressed(true);if(ticks%10==0&&c.player.squaredDistanceTo(entity)>144)return TaskRuntime.Step.failed("retreated_low_health");return TaskRuntime.Step.running();}
   double distance=entity.squaredDistanceTo(c.player);
   var item=c.player.getMainHandStack().getItem();
   boolean ranged=item instanceof BowItem||item instanceof CrossbowItem||item instanceof TridentItem;
   if(distance>(ranged?225:8)){approach(entity.getBlockPos(),10);return TaskRuntime.Step.running();}
   haltNavigation();look(entity.getEyePos());
   if(ranged){if(!c.player.isUsingItem()&&!startedUse){c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);startedUse=true;phase=0;}if(startedUse&&++phase>=25){c.interactionManager.stopUsingItem(c.player);startedUse=false;}}
   else if(c.player.getAttackCooldownProgress(0)>=.95&&c.player.canInteractWithEntity(entity,0)){c.interactionManager.attackEntity(c.player,entity);c.player.swingHand(Hand.MAIN_HAND);}
   if(c.player.getOffHandStack().isOf(Items.SHIELD)&&!ranged&&entity instanceof LivingEntity living&&living.handSwinging&&c.player.getAttackCooldownProgress(0)<.8)c.interactionManager.interactItem(c.player,Hand.OFF_HAND);
   else if(c.player.isUsingItem()&&c.player.getActiveHand()==Hand.OFF_HAND)c.interactionManager.stopUsingItem(c.player);
   return TaskRuntime.Step.running();
  }
  private TaskRuntime.Step done(Map<String,Object> evidence){return TaskRuntime.Step.done(evidence);}
  private void go(BlockPos target){navigation.start(target.getX(),target.getY(),target.getZ());navigating=true;pathTarget=target;}
  private void approach(BlockPos target,int interval){if(!navigating||(ticks%interval==1&&pathTarget.getSquaredDistance(target)>9)){haltNavigation();go(target);}if(navigation.failed())throw new IllegalStateException("unreachable");}
  private void haltNavigation(){if(navigating){navigation.stop();navigating=false;}}
  private boolean visible(BlockPos target){var eye=c.player.getEyePos();if(eye.squaredDistanceTo(target.toCenterPos())>1024)return false;var hit=c.world.raycast(new RaycastContext(eye,target.toCenterPos(),RaycastContext.ShapeType.OUTLINE,RaycastContext.FluidHandling.NONE,c.player));return hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(target);}
  private boolean reachable(BlockPos target){return c.player.canInteractWithBlockAt(target,0)&&visible(target);}
  private Direction face(BlockPos target){var ray=c.world.raycast(new RaycastContext(c.player.getEyePos(),target.toCenterPos(),RaycastContext.ShapeType.OUTLINE,RaycastContext.FluidHandling.NONE,c.player));return ray.getSide();}
  private void look(Vec3d target){var delta=target.subtract(c.player.getEyePos());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z)),pitch=(float)-Math.toDegrees(Math.atan2(delta.y,Math.sqrt(delta.x*delta.x+delta.z*delta.z)));c.player.setYaw(c.player.getYaw()+MathHelper.clamp(MathHelper.wrapDegrees(yaw-c.player.getYaw()),-18,18));c.player.setPitch(c.player.getPitch()+MathHelper.clamp(pitch-c.player.getPitch(),-14,14));}
  private void selectTool(){float best=1;int slot=c.player.getInventory().selectedSlot;for(int i=0;i<9;i++){var stack=c.player.getInventory().getStack(i);float speed=stack.getMiningSpeedMultiplier(c.world.getBlockState(pos));if(speed>best){best=speed;slot=i;}}c.player.getInventory().selectedSlot=slot;}
  private int foodSlot(){for(int i=0;i<9;i++)if(c.player.getInventory().getStack(i).contains(net.minecraft.component.DataComponentTypes.FOOD))return i;return -1;}
  private int count(String item){int n=0;for(int i=0;i<c.player.getInventory().size();i++){var stack=c.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(item))n+=stack.getCount();}return n;}
  private String inventoryState(){StringBuilder value=new StringBuilder();for(var slot:c.player.currentScreenHandler.slots){var stack=slot.getStack();if(!stack.isEmpty())value.append(slot.id).append(':').append(Registries.ITEM.getId(stack.getItem())).append('*').append(stack.getCount()).append('@').append(stack.getComponents().hashCode()).append(';');}return value.append("cursor:").append(c.player.currentScreenHandler.getCursorStack()).toString();}
  private String screenName(){return GameObservation.screenId(c.player.currentScreenHandler);}
  public void pause(){haltNavigation();release();}
  public void resume(){if(skill.equals("navigate"))go(pos);}
  public void stop(){haltNavigation();release();}
  private void release(){if(c.interactionManager!=null){c.interactionManager.cancelBlockBreaking();if(c.player!=null&&c.player.isUsingItem())c.interactionManager.stopUsingItem(c.player);}c.options.forwardKey.setPressed(false);c.options.backKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.attackKey.setPressed(false);c.options.useKey.setPressed(false);}
  public Map<String,Object> progress(){return Map.of("skill",skill,"ticks",ticks);}
  public boolean acceptsScreen(Object screen){return screen==ownedScreen||((skill.equals("interactBlock")||skill.equals("interactEntity"))&&phase>0&&screen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>);}
 }
}
