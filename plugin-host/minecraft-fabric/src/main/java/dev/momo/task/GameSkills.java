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
  if(skill.equals("gather"))return new GatherSkill(args);
  if(skill.equals("plan")){
   var work=new ArrayList<TaskPlan.Node>();
   for(var value:args.getAsJsonArray("steps")){
    var step=value.getAsJsonObject();var condition=step.has("when")?step.getAsJsonObject("when"):null;
    work.add(new TaskPlan.Node(create(step.get("skill").getAsString(),step.getAsJsonObject("args")),()->{
     if(condition==null)return true;var client=MinecraftClient.getInstance();int count=0;
     if(client.player==null)return false;
     String expected=SkillArguments.resourceId(condition.get("item").getAsString());
     for(int i=0;i<client.player.getInventory().size();i++){var stack=client.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(expected))count+=stack.getCount();}
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
  BlockPos pos,placed,pathTarget,lastSeen;Entity entity;Screen ownedScreen;boolean navigating,startedUse;int ticks,actionIndex,phase,startFood,beforeCount,lostTicks;String beforeState,inventoryBefore,outputItem;InventoryEvidence inventoryProof;int mutationTick,craftPhase;final long pickupBoundary=PickupLedger.CURRENT.cursor();float startHealth;int targetSlot;
  long blockBoundary;String beforeBlock;int predictedChangeTick;
  boolean placeSent,inventoryPending,buttonPending;String placedItem;int verifiedActions;
  net.minecraft.client.world.ClientWorld proofWorld;int proofHandler;long slotBoundary;SlotProof slotProof;
  Map<String,Object> verifiedGain=Map.of(),verifiedSlots=Map.of();
  Skill(String skill,JsonObject args){this.skill=skill;this.args=args;ownedScreen=c.currentScreen;}
  public void start(){
   if(c.player==null||c.world==null||c.interactionManager==null)throw new TaskRuntime.Rejected("world_unavailable");
   ticks=0;phase=0;predictedChangeTick=0;inventoryBefore=inventoryState();startFood=c.player.getHungerManager().getFoodLevel();startHealth=c.player.getHealth();
   ownedScreen=c.currentScreen;
   proofWorld=c.world;proofHandler=c.player.currentScreenHandler.syncId;placeSent=inventoryPending=buttonPending=false;verifiedActions=0;
   if(Set.of("navigate","mine","place","interactBlock").contains(skill)){
    pos=position(args);boolean surface=skill.equals("navigate")&&args.has("height")&&args.get("height").getAsString().equals("surface");if(!c.world.isChunkLoaded(pos)||!NavigationBounds.within(c.player.getX(),c.player.getY(),c.player.getZ(),pos.getX(),pos.getY(),pos.getZ(),surface))throw new TaskRuntime.Rejected("outside_known_terrain");
    if(!skill.equals("navigate")&&!visible(pos))throw new TaskRuntime.Rejected("target_not_visible");
    if(!skill.equals("navigate")){beforeState=c.world.getBlockState(pos).toString();beforeBlock=Registries.BLOCK.getId(c.world.getBlockState(pos).getBlock()).toString();blockBoundary=BlockReceipts.CURRENT.cursor();}
   }
   if(Set.of("follow","interactEntity","attack").contains(skill)){
    entity=c.world.getEntityById(args.get("entityId").getAsInt());
    if(entity==null||!c.player.canSee(entity)||entity.squaredDistanceTo(c.player)>1024)throw new TaskRuntime.Rejected("target_not_visible");lastSeen=entity.getBlockPos();
   }
   if(skill.equals("navigate"))go(pos);
   if(skill.equals("mine")&&!c.world.getBlockState(pos).isAir())selectTool();
   if(skill.equals("place")){
    targetSlot=args.get("slot").getAsInt();c.player.getInventory().selectedSlot=targetSlot;var stack=c.player.getMainHandStack();
    if(!(stack.getItem() instanceof BlockItem))throw new TaskRuntime.Rejected("block_item_required");
    placedItem=Registries.ITEM.getId(stack.getItem()).toString();var dir=direction(args);var hit=new BlockHitResult(pos.toCenterPos().add(Vec3d.of(dir.getVector()).multiply(.5)),dir,pos,false);
    placed=new ItemPlacementContext(c.player,Hand.MAIN_HAND,stack,hit).getBlockPos();beforeState=c.world.getBlockState(placed).toString();
   }
   if(skill.equals("pickup")){
    int id=args.get("entityId").getAsInt();
    if(PickupLedger.CURRENT.since(c.world,id,c.player.getId(),pickupBoundary)==null){
     entity=c.world.getEntityById(id);
     if(!(entity instanceof net.minecraft.entity.ItemEntity drop)||!c.player.canSee(entity))throw new TaskRuntime.Rejected("target_not_visible");
     outputItem=Registries.ITEM.getId(drop.getStack().getItem()).toString();beforeCount=count(outputItem);
    }
   }
   if(skill.equals("trade")){
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.MerchantScreenHandler merchant))throw new TaskRuntime.Rejected("station_required");
    int index=args.get("index").getAsInt();if(index>=merchant.getRecipes().size()||merchant.getRecipes().get(index).isDisabled())throw new TaskRuntime.Rejected("trade_unavailable");
    var offer=merchant.getRecipes().get(index);outputItem=Registries.ITEM.getId(offer.getSellItem().getItem()).toString();beforeCount=count(outputItem);targetSlot=offer.getSellItem().getCount()*args.get("count").getAsInt();
    if(!c.player.currentScreenHandler.getCursorStack().isEmpty())throw new TaskRuntime.Rejected("cursor_not_empty");inventoryProof=new InventoryEvidence(beforeCount,c.player.currentScreenHandler.getRevision());craftPhase=1;
    merchant.setRecipeIndex(index);merchant.switchTo(index);c.player.networkHandler.sendPacket(new net.minecraft.network.packet.c2s.play.SelectMerchantTradeC2SPacket(index));
   }
   if(skill.equals("eat")){targetSlot=foodSlot();if(targetSlot<0)throw new TaskRuntime.Rejected("food_missing");c.player.getInventory().selectedSlot=targetSlot;beforeCount=c.player.getMainHandStack().getCount();if(!c.player.canConsume(c.player.getMainHandStack().get(net.minecraft.component.DataComponentTypes.FOOD).canAlwaysEat()))throw new TaskRuntime.Rejected("not_hungry");}
   if(skill.equals("useItem")){c.player.getInventory().selectedSlot=args.get("slot").getAsInt();beforeCount=c.player.getMainHandStack().getCount();}
   if(skill.equals("inventory")||skill.equals("workstation")){
    if(skill.equals("inventory")&&c.currentScreen==null)c.setScreen(new InventoryScreen(c.player));
    ownedScreen=c.currentScreen;
    if(!screenName().equals(args.get("screen").getAsString()))throw new TaskRuntime.Rejected("screen_changed");
    inventoryProof=new InventoryEvidence(0,c.player.currentScreenHandler.getRevision());
   }
   if(skill.equals("waitFor")&&args.get("area").getAsString().equals("screen")&&StationOutputs.indices(screenName()).isEmpty())throw new TaskRuntime.Rejected("station_required");
   if(skill.equals("craft")){
    if(c.currentScreen==null)c.setScreen(new InventoryScreen(c.player));ownedScreen=c.currentScreen;
    var recipe=c.world.getRecipeManager().get(identifier(args,"recipe")).orElseThrow(()->new IllegalArgumentException("Unknown recipe"));
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.CraftingScreenHandler||c.player.currentScreenHandler instanceof net.minecraft.screen.PlayerScreenHandler))throw new TaskRuntime.Rejected("station_required");
    if(!c.player.getRecipeBook().contains(recipe))throw new TaskRuntime.Rejected("recipe_unknown");
    var output=recipe.value().getResult(c.world.getRegistryManager());outputItem=Registries.ITEM.getId(output.getItem()).toString();beforeCount=count(outputItem);
    if(!c.player.currentScreenHandler.getCursorStack().isEmpty())throw new TaskRuntime.Rejected("cursor_not_empty");
    inventoryProof=new InventoryEvidence(beforeCount,c.player.currentScreenHandler.getRevision());
   }
   if(skill.equals("closeScreen"))c.player.closeHandledScreen();
   if(skill.equals("respawn")){if(c.player.isAlive())throw new TaskRuntime.Rejected("already_alive");c.player.requestRespawn();}
  }
  public TaskRuntime.Step tick(){
   if(++ticks>2400)return TaskRuntime.Step.failed("skill_timeout");
   if(skill.equals("respawn"))return c.player.isAlive()?done(Map.of("alive",true)):TaskRuntime.Step.running();
   if(!c.player.isAlive())return TaskRuntime.Step.failed("dead");
   switch(skill){
    case "wait":return ticks>=args.get("ticks").getAsInt()?done(Map.of("elapsedGameTicks",ticks)):TaskRuntime.Step.running();
    case "navigate":
     boolean arrived=navigation.arrived();phase=NavigationBounds.arrivalTicks(arrived,c.player.isOnGround()||c.player.isTouchingWater()||c.player.isClimbing(),phase);
     if(phase>=4){haltNavigation();c.player.setPitch(NavigationBounds.horizonPitch(c.player.getPitch()));return done(Map.of("x",c.player.getX(),"y",c.player.getY(),"z",c.player.getZ(),"arrived",true));}
     if(NavigationBounds.failed(arrived,navigation.failed()))return TaskRuntime.Step.failed("unreachable");break;
    case "follow":
     if(!entity.isAlive())return TaskRuntime.Step.failed("target_lost");
     if(!c.player.canSee(entity)){if(++lostTicks>60)return TaskRuntime.Step.failed("target_lost");approach(lastSeen,20);break;}lostTicks=0;lastSeen=entity.getBlockPos();
     if(entity.squaredDistanceTo(c.player)<9){haltNavigation();return done(Map.of("entityId",entity.getId(),"distance",Math.sqrt(entity.squaredDistanceTo(c.player))));}
     approach(entity.getBlockPos(),20);break;
    case "mine":
     var mined=BlockReceipts.CURRENT.after(c.world,pos.getX(),pos.getY(),pos.getZ(),blockBoundary);
     if(mined!=null&&!mined.block().equals(beforeBlock))return done(Map.of("block",beforeState,"x",pos.getX(),"y",pos.getY(),"z",pos.getZ(),"after",mined.state(),"serverBlockSeq",mined.seq()));
     if(!Registries.BLOCK.getId(c.world.getBlockState(pos).getBlock()).toString().equals(beforeBlock)){
      if(predictedChangeTick==0)predictedChangeTick=ticks;
      if(ticks-predictedChangeTick>100)return TaskRuntime.Step.failed("server_confirmation_missing");
      break;
     }
     if(predictedChangeTick!=0&&mined!=null)return TaskRuntime.Step.failed("block_change_rejected");
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();look(pos.toCenterPos());
     c.interactionManager.updateBlockBreakingProgress(pos,face(pos));c.player.swingHand(Hand.MAIN_HAND);break;
    case "place":
     var built=BlockReceipts.CURRENT.after(c.world,placed.getX(),placed.getY(),placed.getZ(),blockBoundary);
     if(placeSent&&built!=null&&!built.state().equals(beforeState)){
      var actual=Registries.BLOCK.get(Identifier.of(built.block()));
      if(PlacementEvidence.matches(placedItem,Registries.ITEM.getId(actual.asItem()).toString(),actual.getDefaultState().isAir(),built.seq(),blockBoundary))return done(Map.of("x",placed.getX(),"y",placed.getY(),"z",placed.getZ(),"block",built.state(),"serverBlockSeq",built.seq()));
     }
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
     if(++phase>100)return TaskRuntime.Step.failed(built==null&&placeSent?"server_confirmation_missing":"placement_blocked_or_material_missing");
     if(ticks%6==1){var direction=direction(args);var hit=new BlockHitResult(pos.toCenterPos().add(Vec3d.of(direction.getVector()).multiply(.5)),direction,pos,false);look(hit.getPos());if(!placeSent){blockBoundary=BlockReceipts.CURRENT.cursor();placeSent=true;}c.interactionManager.interactBlock(c.player,Hand.MAIN_HAND,hit);c.player.swingHand(Hand.MAIN_HAND);}break;
    case "interactBlock":
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
     if(phase++==0){look(pos.toCenterPos());c.interactionManager.interactBlock(c.player,Hand.MAIN_HAND,new BlockHitResult(pos.toCenterPos(),face(pos),pos,false));}
     if(ticks>4&&(c.currentScreen!=ownedScreen||!c.world.getBlockState(pos).toString().equals(beforeState)||!inventoryState().equals(inventoryBefore)||c.player.hasVehicle()||c.player.isSleeping()))return done(Map.of("screen",screenName(),"block",c.world.getBlockState(pos).toString(),"riding",c.player.hasVehicle(),"sleeping",c.player.isSleeping()));
     if(phase>80)return TaskRuntime.Step.failed("no_interaction_result");break;
    case "interactEntity":
     if(entity.squaredDistanceTo(c.player)>9){approach(entity.getBlockPos(),20);break;}haltNavigation();
     if(phase++==0){look(entity.getEyePos());c.interactionManager.interactEntity(c.player,entity,Hand.MAIN_HAND);}
     if(ticks>4&&(c.currentScreen!=ownedScreen||c.player.hasVehicle()||!inventoryState().equals(inventoryBefore)))return done(Map.of("entityId",entity.getId(),"screen",screenName(),"riding",c.player.hasVehicle(),"inventoryChanged",!inventoryState().equals(inventoryBefore)));
     if(phase>80)return TaskRuntime.Step.failed("no_interaction_result");break;
    case "pickup":
     var receipt=PickupLedger.CURRENT.since(c.world,args.get("entityId").getAsInt(),c.player.getId(),pickupBoundary);
     if(receipt!=null)return done(Map.of("entityId",receipt.entityId(),"pickedCount",receipt.amount(),"serverPickupSeq",receipt.seq()));
     if(entity==null||entity.isRemoved())return TaskRuntime.Step.failed("drop_gone_without_own_pickup");
     if(navigating&&navigation.arrived()){haltNavigation();look(entity.getPos());c.options.forwardKey.setPressed(true);c.options.jumpKey.setPressed(c.player.horizontalCollision);}
     else if(!c.options.forwardKey.isPressed())approach(entity.getBlockPos(),20);
     break;
    case "waitFor":
     int present=0;
     if(args.get("area").getAsString().equals("inventory")){for(int i=0;i<c.player.getInventory().size();i++){var stack=c.player.getInventory().getStack(i);if(expectedStack(stack))present+=stack.getCount();}}
     else for(int index:StationOutputs.indices(screenName()))if(index<c.player.currentScreenHandler.slots.size()){var stack=c.player.currentScreenHandler.getSlot(index).getStack();if(expectedStack(stack))present+=stack.getCount();}
     if(present>=args.get("count").getAsInt())return done(Map.of("item",args.get("item").getAsString(),"count",present));
     if(ticks>=args.get("ticks").getAsInt())return TaskRuntime.Step.failed("processing_result_timeout");break;
    case "trade":
     if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.MerchantScreenHandler))return TaskRuntime.Step.failed("merchant_closed");
     if(gainSettled()){
      verifiedGain=gainReceipt();
      if(count(outputItem)-beforeCount>=targetSlot)return done(verifiedGain);
      craftPhase=1;mutationTick=ticks;
     }
     takeOneOutput(2);
     if(ticks-mutationTick>100)return TaskRuntime.Step.failed("trade_stock_or_currency_missing");break;
    case "attack": return combat();
    case "eat":
     if(c.player.getHungerManager().getFoodLevel()>startFood||c.player.getMainHandStack().getCount()<beforeCount)return done(Map.of("foodBefore",startFood,"foodAfter",c.player.getHungerManager().getFoodLevel(),"remaining",c.player.getMainHandStack().getCount()));
     c.options.useKey.setPressed(true);
     if(ticks%4==1&&!c.player.isUsingItem())c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);break;
    case "useItem":
     c.options.useKey.setPressed(c.player.getMainHandStack().getUseAction()!=net.minecraft.util.UseAction.NONE);
     if(ticks==1)c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);
     if(ticks>=args.get("ticks").getAsInt())return done(Map.of("ticks",ticks,"item",Registries.ITEM.getId(c.player.getMainHandStack().getItem()).toString(),"countBefore",beforeCount,"countAfter",c.player.getMainHandStack().getCount(),"using",c.player.isUsingItem()));break;
    case "inventory","workstation":
     if(!screenName().equals(args.get("screen").getAsString()))return TaskRuntime.Step.failed("screen_changed");
     if(inventoryPending){
      boolean confirmed=slotSettled()||(buttonPending&&slotProof.settledButton(ticks,InventoryReceipts.CURRENT.changes(proofWorld,proofHandler,slotBoundary)));
      if(confirmed){inventoryPending=false;verifiedActions++;verifiedSlots=inventoryReceipt(inventoryState());if(actionIndex>=args.getAsJsonArray("actions").size())return done(verifiedSlots);}
      else if(ticks-mutationTick>100)return TaskRuntime.Step.failed(slotReceipt()==null&&!buttonPending?"server_confirmation_missing":"slot_change_rejected");
     }
     if(!inventoryPending&&ticks%4==1&&actionIndex<args.getAsJsonArray("actions").size()){
      var a=args.getAsJsonArray("actions").get(actionIndex++).getAsJsonObject();int slot=a.get("slot").getAsInt(),button=a.get("button").getAsInt();String mode=a.get("mode").getAsString();
      buttonPending=mode.equals("button");
      if(buttonPending){
       if(!StationOutputs.hasButtons(screenName()))return TaskRuntime.Step.failed("station_button_unsupported");
       slotBoundary=InventoryReceipts.CURRENT.cursor();slotProof=new SlotProof(SlotConfirmation.snapshot(c),SlotConfirmation.fingerprint(c.player.currentScreenHandler.getCursorStack()));
       var watched=new HashSet<Integer>();for(var target:c.player.currentScreenHandler.slots)if(target.inventory!=c.player.getInventory())watched.add(target.id);slotProof.buttonSlots(watched);
       c.interactionManager.clickButton(c.player.currentScreenHandler.syncId,slot);slotProof.mutated(ticks,slotBoundary,SlotConfirmation.snapshot(c),SlotConfirmation.fingerprint(c.player.currentScreenHandler.getCursorStack()));mutationTick=ticks;
      }else {if(slot>=c.player.currentScreenHandler.slots.size())return TaskRuntime.Step.failed("slot_missing");verifiedClick(slot,button,switch(mode){case "quickMove"->SlotActionType.QUICK_MOVE;case "swap"->SlotActionType.SWAP;case "throw"->SlotActionType.THROW;default->SlotActionType.PICKUP;});}
      inventoryPending=true;
     }
     break;
    case "craft":
     int gained=count(outputItem)-beforeCount;
     if(gainSettled()){
      verifiedGain=gainReceipt();
      if(gained>=args.get("count").getAsInt())return done(verifiedGain);
      craftPhase=0;
     }
     if(craftPhase==0){c.interactionManager.clickRecipe(c.player.currentScreenHandler.syncId,c.world.getRecipeManager().get(identifier(args,"recipe")).orElseThrow(),false);mutationTick=ticks;craftPhase=1;}
     else takeOneOutput(0);
     if(ticks-mutationTick>100)return TaskRuntime.Step.failed("ingredients_station_or_server_ack_missing");break;
    case "closeScreen":if(c.currentScreen==null)return done(Map.of("screen","world"));break;
    default: return TaskRuntime.Step.failed("unsupported_skill");
   }
   return TaskRuntime.Step.running();
  }
  private void takeOneOutput(int outputSlot){
   if(craftPhase==1&&ticks-mutationTick>=4&&!c.player.currentScreenHandler.getSlot(outputSlot).getStack().isEmpty()){
      // Pickup exactly one recipe output, rather than shift-crafting every available ingredient.
      verifiedClick(outputSlot,0,SlotActionType.PICKUP);craftPhase=2;
     }else if(craftPhase==2&&ticks-mutationTick>=3&&!c.player.currentScreenHandler.getCursorStack().isEmpty()){
      var cursor=c.player.currentScreenHandler.getCursorStack();
      var destination=c.player.currentScreenHandler.slots.stream().filter(slot->slot.inventory==c.player.getInventory()&&slot.canInsert(cursor)&&slot.getStack().isEmpty()).findFirst();
      if(destination.isEmpty())destination=c.player.currentScreenHandler.slots.stream().filter(slot->slot.inventory==c.player.getInventory()&&slot.canInsert(cursor)&&net.minecraft.item.ItemStack.areItemsAndComponentsEqual(slot.getStack(),cursor)&&slot.getStack().getCount()+cursor.getCount()<=slot.getMaxItemCount(cursor)).findFirst();
      if(destination.isEmpty())throw new TaskRuntime.Rejected("inventory_full");
      verifiedClick(destination.get().id,0,SlotActionType.PICKUP);inventoryProof.mutated(ticks,c.player.currentScreenHandler.getRevision());craftPhase=3;
     }
  }
  private TaskRuntime.Step combat(){
   var outcome=CombatOutcome.of(entity.isRemoved(),entity.getRemovalReason()==Entity.RemovalReason.KILLED,entity instanceof LivingEntity living?living.getHealth():Float.POSITIVE_INFINITY);
   if(outcome==CombatOutcome.DEAD)return done(Map.of("entityId",entity.getId(),"targetAlive",false));
   if(outcome==CombatOutcome.LOST)return TaskRuntime.Step.failed("target_lost");
   if(!c.player.canSee(entity)){
    if(++lostTicks>40)return TaskRuntime.Step.failed("target_lost");
    if(c.player.squaredDistanceTo(lastSeen.toCenterPos())>4)approach(lastSeen,10);else{haltNavigation();look(lastSeen.toCenterPos());}
    return TaskRuntime.Step.running();
   }
   lostTicks=0;lastSeen=entity.getBlockPos();
   if(entity.squaredDistanceTo(c.player)>1024)return TaskRuntime.Step.failed("target_lost");
   if(c.player.getHealth()<=6){haltNavigation();look(entity.getEyePos());c.options.backKey.setPressed(true);c.options.sprintKey.setPressed(true);if(ticks%10==0&&c.player.squaredDistanceTo(entity)>144)return TaskRuntime.Step.failed("retreated_low_health");return TaskRuntime.Step.running();}
   double distance=entity.squaredDistanceTo(c.player);
   var item=c.player.getMainHandStack().getItem();
   boolean ranged=item instanceof BowItem||item instanceof CrossbowItem||item instanceof TridentItem;
   c.options.useKey.setPressed(false);
   if(distance>(ranged?225:8)){approach(entity.getBlockPos(),10);return TaskRuntime.Step.running();}
   haltNavigation();look(entity.getEyePos());
   if(ranged){
    var stack=c.player.getMainHandStack();
    if(item instanceof CrossbowItem&&CrossbowItem.isCharged(stack)){c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);startedUse=false;}
    else{
     if((item instanceof BowItem||item instanceof CrossbowItem)&&!c.player.getAbilities().creativeMode&&c.player.getProjectileType(stack).isEmpty())return TaskRuntime.Step.failed("ammunition_missing");
     c.options.useKey.setPressed(true);
     if(!c.player.isUsingItem()&&!startedUse){c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);startedUse=true;phase=0;}
     if(startedUse&&++phase>=28){c.options.useKey.setPressed(false);c.interactionManager.stopUsingItem(c.player);startedUse=false;}
    }
   }
   else if(c.player.getAttackCooldownProgress(0)>=.95&&c.player.canInteractWithEntity(entity,0)){if(c.player.isUsingItem())c.interactionManager.stopUsingItem(c.player);c.interactionManager.attackEntity(c.player,entity);c.player.swingHand(Hand.MAIN_HAND);}
   if(c.player.getOffHandStack().isOf(Items.SHIELD)&&!ranged&&entity instanceof LivingEntity living&&living.handSwinging&&c.player.getAttackCooldownProgress(0)<.8){c.options.useKey.setPressed(true);if(!c.player.isUsingItem())c.interactionManager.interactItem(c.player,Hand.OFF_HAND);}
   else if(c.player.isUsingItem()&&c.player.getActiveHand()==Hand.OFF_HAND)c.interactionManager.stopUsingItem(c.player);
   return TaskRuntime.Step.running();
  }
  private void verifiedClick(int slot,int button,SlotActionType mode){
   proofHandler=c.player.currentScreenHandler.syncId;slotBoundary=InventoryReceipts.CURRENT.cursor();slotProof=new SlotProof(SlotConfirmation.snapshot(c),SlotConfirmation.fingerprint(c.player.currentScreenHandler.getCursorStack()));
   SlotConfirmation.click(c,slot,button,mode);mutationTick=ticks;slotProof.mutated(ticks,slotBoundary,SlotConfirmation.snapshot(c),SlotConfirmation.fingerprint(c.player.currentScreenHandler.getCursorStack()));
  }
  private InventoryReceipts.Receipt slotReceipt(){return c.world==proofWorld?InventoryReceipts.CURRENT.after(proofWorld,proofHandler,slotBoundary):null;}
  private boolean slotSettled(){return slotProof!=null&&slotProof.settled(ticks,slotReceipt());}
  private boolean gainSettled(){return craftPhase==3&&c.world==proofWorld&&slotSettled()&&inventoryProof.settled(ticks,count(outputItem),c.player.currentScreenHandler.getCursorStack().isEmpty(),c.player.currentScreenHandler.getRevision());}
  private Map<String,Object> gainReceipt(){return Map.of("item",outputItem,"countBefore",beforeCount,"countAfter",count(outputItem),"serverRevision",c.player.currentScreenHandler.getRevision(),"serverSnapshotSeq",slotReceipt().sequence());}
  private TaskRuntime.Step done(Map<String,Object> evidence){return TaskRuntime.Step.done(evidence);}
  private boolean expectedStack(ItemStack stack){
   if(!Registries.ITEM.getId(stack.getItem()).equals(identifier(args,"item")))return false;
   if(!args.has("potion"))return true;
   var contents=stack.get(net.minecraft.component.DataComponentTypes.POTION_CONTENTS);
   return contents!=null&&contents.potion().filter(potion->potion.matchesId(Identifier.of(args.get("potion").getAsString()))).isPresent();
  }
  private Map<String,Object> inventoryReceipt(String after){
   var ids=new LinkedHashSet<Integer>();for(var action:args.getAsJsonArray("actions"))ids.add(action.getAsJsonObject().get("slot").getAsInt());
   var slots=new ArrayList<Map<String,Object>>();for(int id:ids)if(id>=0&&id<c.player.currentScreenHandler.slots.size()){var stack=c.player.currentScreenHandler.getSlot(id).getStack();slots.add(Map.of("id",id,"item",Registries.ITEM.getId(stack.getItem()).toString(),"count",stack.getCount()));}
   return Map.of("beforeDigest",digest(inventoryBefore),"afterDigest",digest(after),"screen",screenName(),"slots",slots,"cursor",GameObservation.stack(c.player.currentScreenHandler.getCursorStack()),"completedActions",verifiedActions,"serverConfirmationSeq",InventoryReceipts.CURRENT.cursor());
  }
  private static String digest(String value){try{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
  private void go(BlockPos target){navigation.start(target.getX(),target.getY(),target.getZ(),skill.equals("navigate")&&args.has("height")&&args.get("height").getAsString().equals("surface"));navigating=true;pathTarget=target;}
  private void approach(BlockPos target,int interval){
   boolean settled=navigating&&(navigation.arrived()||navigation.failed());
   if(NavigationBounds.retarget(navigating,settled,navigating?pathTarget.getSquaredDistance(target):0,ticks%interval==1)){haltNavigation();go(target);}
   else if(settled)throw new TaskRuntime.Rejected("unreachable");
  }
  private void haltNavigation(){if(navigating){navigation.stop();navigating=false;}}
  private RaycastContext.ShapeType sightShape(BlockPos target){return c.world.getBlockState(target).getCollisionShape(c.world,target).isEmpty()?RaycastContext.ShapeType.OUTLINE:RaycastContext.ShapeType.COLLIDER;}
  private boolean visible(BlockPos target){var eye=c.player.getEyePos();if(eye.squaredDistanceTo(target.toCenterPos())>1024)return false;var hit=c.world.raycast(new RaycastContext(eye,target.toCenterPos(),sightShape(target),RaycastContext.FluidHandling.NONE,c.player));return hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(target);}
  private boolean reachable(BlockPos target){return c.player.canInteractWithBlockAt(target,0)&&visible(target);}
  private Direction face(BlockPos target){var ray=c.world.raycast(new RaycastContext(c.player.getEyePos(),target.toCenterPos(),sightShape(target),RaycastContext.FluidHandling.NONE,c.player));return ray.getSide();}
  private void look(Vec3d target){var delta=target.subtract(c.player.getEyePos());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z)),pitch=(float)-Math.toDegrees(Math.atan2(delta.y,Math.sqrt(delta.x*delta.x+delta.z*delta.z)));c.player.setYaw(c.player.getYaw()+MathHelper.clamp(MathHelper.wrapDegrees(yaw-c.player.getYaw()),-18,18));c.player.setPitch(c.player.getPitch()+MathHelper.clamp(pitch-c.player.getPitch(),-14,14));}
  private void selectTool(){float best=1;int slot=c.player.getInventory().selectedSlot;for(int i=0;i<9;i++){var stack=c.player.getInventory().getStack(i);float speed=stack.getMiningSpeedMultiplier(c.world.getBlockState(pos));if(speed>best){best=speed;slot=i;}}c.player.getInventory().selectedSlot=slot;}
  private int foodSlot(){for(int i=0;i<9;i++)if(c.player.getInventory().getStack(i).contains(net.minecraft.component.DataComponentTypes.FOOD))return i;return -1;}
  private int count(String item){int n=0;for(int i=0;i<c.player.getInventory().size();i++){var stack=c.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(item))n+=stack.getCount();}return n;}
  private String inventoryState(){StringBuilder value=new StringBuilder();for(var slot:c.player.currentScreenHandler.slots){var stack=slot.getStack();if(!stack.isEmpty())value.append(slot.id).append(':').append(Registries.ITEM.getId(stack.getItem())).append('*').append(stack.getCount()).append('@').append(stack.getComponents().hashCode()).append(';');}return value.append("cursor:").append(c.player.currentScreenHandler.getCursorStack()).toString();}
  private String screenName(){return GameObservation.screenId(c.player.currentScreenHandler);}
  public void pause(){haltNavigation();release();}
  public boolean controlsMining(){return skill.equals("mine")&&!navigating;}
  public boolean handlesCombat(){return skill.equals("attack");}
  public boolean retrySafe(String reason){return Set.of("navigate","follow","wait","waitFor").contains(skill)||Set.of("target_not_visible","outside_known_terrain","block_change_rejected").contains(reason);}
  public Map<String,Object> partialEvidence(){
   if(c.player!=null&&inventoryProof!=null&&outputItem!=null&&gainSettled())return gainReceipt();
   return !verifiedSlots.isEmpty()?verifiedSlots:verifiedGain;
  }
  public void resume(){if(Set.of("inventory","workstation","craft","trade","waitFor").contains(skill)&&c.currentScreen!=ownedScreen)throw new IllegalStateException("station_screen_changed");if(skill.equals("navigate"))go(pos);}
  public void stop(){haltNavigation();release();}
  private void release(){if(c.interactionManager!=null){c.interactionManager.cancelBlockBreaking();if(c.player!=null&&c.player.isUsingItem())c.interactionManager.stopUsingItem(c.player);}c.options.forwardKey.setPressed(false);c.options.backKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.attackKey.setPressed(false);c.options.useKey.setPressed(false);}
  public Map<String,Object> progress(){return Map.of("skill",skill,"ticks",ticks,"phase",craftPhase);}
  public boolean acceptsScreen(Object screen){return screen==ownedScreen||((skill.equals("interactBlock")||skill.equals("interactEntity"))&&phase>0&&screen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>);}
 }
}
