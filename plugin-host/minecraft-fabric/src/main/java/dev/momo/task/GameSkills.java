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
 static TaskRuntime.Work consumeFood(){return new Skill("eat",new JsonObject());}
 static TaskRuntime.Work rawMine(JsonObject args,boolean protectedSupport,Vec3d observedPoint){var work=new Skill("mine",args.deepCopy());work.protectSupport=protectedSupport;work.observedPoint=observedPoint;return work;}
 static TaskRuntime.Work gatherMine(JsonObject args,Vec3d observedPoint){SkillArguments.validate("mine",args);return PreparedMineSkill.create(args,true,observedPoint);}
 public static TaskRuntime.Work create(String skill,JsonObject args){
  SkillArguments.validate(skill,args);
  if(skill.equals("gather"))return new GatherSkill(args);
  if(skill.equals("mine"))return PreparedMineSkill.create(args,false);
  if(skill.equals("eat"))return new EatSkill();
  if(skill.equals("selectItem"))return new SelectItemSkill(args);
  if(skill.equals("placeNearby"))return new NearbyPlacementSkill(args);
  if(skill.equals("build"))return BuildScene.create(args);
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
  final CombatWithdrawal withdrawal=new CombatWithdrawal();
  final EscapeMovement escape=new EscapeMovement();
  BlockPos pos,placed,pathTarget,lastSeen;Entity entity;Screen ownedScreen;boolean navigating,startedUse;int ticks,actionIndex,phase,startFood,beforeCount,lostTicks;String beforeState,inventoryBefore,outputItem;InventoryEvidence inventoryProof;int mutationTick,craftPhase;final long pickupBoundary=PickupLedger.CURRENT.cursor();float startHealth;int targetSlot;
  long renameBoundary;String renameName;boolean renameUnchanged;int startExperience;
  long blockBoundary;String beforeBlock;int predictedChangeTick;
  boolean placeSent,inventoryPending,buttonPending,protectSupport,swimming;String placedItem;int verifiedActions;
  net.minecraft.client.world.ClientWorld proofWorld;int proofHandler;long slotBoundary;SlotProof slotProof;
  Map<String,Object> verifiedGain=Map.of(),verifiedSlots=Map.of();
  InteractionOutcome interaction;SeenTarget<BlockPos> seenTarget;Vec3d observedPoint;
  Skill(String skill,JsonObject args){this.skill=skill;this.args=args;ownedScreen=c.currentScreen;}
  public void start(){
   if(c.player==null||c.world==null||c.interactionManager==null)throw new TaskRuntime.Rejected("world_unavailable");
   ticks=0;phase=0;interaction=null;predictedChangeTick=0;inventoryBefore=inventoryState();startFood=c.player.getHungerManager().getFoodLevel();startHealth=c.player.getHealth();
   ownedScreen=c.currentScreen;
   proofWorld=c.world;proofHandler=c.player.currentScreenHandler.syncId;placeSent=inventoryPending=buttonPending=false;verifiedActions=0;
   if(Set.of("navigate","mine","place","interactBlock").contains(skill)){
    boolean surface=skill.equals("navigate")&&args.has("height")&&args.get("height").getAsString().equals("surface");
    pos=surface&&!args.has("y")?new BlockPos(integer(args,"x",-30000000,30000000),c.player.getBlockY(),integer(args,"z",-30000000,30000000)):position(args);
    if(!c.world.isChunkLoaded(pos)||!NavigationBounds.within(c.player.getX(),c.player.getY(),c.player.getZ(),pos.getX(),pos.getY(),pos.getZ(),surface))throw new TaskRuntime.Rejected("outside_known_terrain");
    if(!skill.equals("navigate")&&!visible(pos)){
     if(skill.equals("mine")&&BlockSight.visibleAbsence(c,pos)){
      BlockReceipts.CURRENT.observeAbsence(c.world,c.player.getUuidAsString(),c.world.getRegistryKey().getValue().toString(),pos.getX(),pos.getY(),pos.getZ());
      throw new TaskRuntime.Rejected("target_absent");
     }
     throw new TaskRuntime.Rejected("target_not_visible");
    }
    if(!skill.equals("navigate")){beforeState=c.world.getBlockState(pos).toString();beforeBlock=Registries.BLOCK.getId(c.world.getBlockState(pos).getBlock()).toString();blockBoundary=BlockReceipts.CURRENT.cursor();}
   }
   if(Set.of("follow","interactEntity","attack").contains(skill)){
    entity=c.world.getEntityById(args.get("entityId").getAsInt());
    if(entity==null||!c.player.canSee(entity)||entity.squaredDistanceTo(c.player)>1024)throw new TaskRuntime.Rejected("target_not_visible");lastSeen=entity.getBlockPos();seenTarget=new SeenTarget<>(lastSeen,60);
   }
   if(skill.equals("navigate"))go(pos);
   if(skill.equals("place")){
    targetSlot=args.get("slot").getAsInt();c.player.getInventory().selectedSlot=targetSlot;var stack=c.player.getMainHandStack();
    if(!(stack.getItem() instanceof BlockItem))throw new TaskRuntime.Rejected("block_item_required");
    placedItem=Registries.ITEM.getId(stack.getItem()).toString();var hit=BlockSight.hit(c,pos,direction(args));if(hit==null)throw new TaskRuntime.Rejected("target_not_visible");
    placed=new ItemPlacementContext(c.player,Hand.MAIN_HAND,stack,hit).getBlockPos();beforeState=c.world.getBlockState(placed).toString();
   }
   if(skill.equals("pickup")){
    int id=args.get("entityId").getAsInt();
    if(PickupLedger.CURRENT.since(c.world,id,c.player.getId(),pickupBoundary)==null){
     entity=c.world.getEntityById(id);
     if(!(entity instanceof net.minecraft.entity.ItemEntity drop)||!c.player.canSee(entity))throw new TaskRuntime.Rejected("target_not_visible");
     outputItem=Registries.ITEM.getId(drop.getStack().getItem()).toString();beforeCount=count(outputItem);seenTarget=new SeenTarget<>(entity.getBlockPos(),60);
    }
   }
   if(skill.equals("trade")){
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.MerchantScreenHandler merchant))throw new TaskRuntime.Rejected("station_required");
    int index=args.get("index").getAsInt();if(index>=merchant.getRecipes().size()||merchant.getRecipes().get(index).isDisabled())throw new TaskRuntime.Rejected("trade_unavailable");
    var offer=merchant.getRecipes().get(index);outputItem=Registries.ITEM.getId(offer.getSellItem().getItem()).toString();beforeCount=count(outputItem);targetSlot=offer.getSellItem().getCount()*args.get("count").getAsInt();
    if(!c.player.currentScreenHandler.getCursorStack().isEmpty())throw new TaskRuntime.Rejected("cursor_not_empty");inventoryProof=new InventoryEvidence(beforeCount,c.player.currentScreenHandler.getRevision());craftPhase=1;
    merchant.setRecipeIndex(index);merchant.switchTo(index);c.player.networkHandler.sendPacket(new net.minecraft.network.packet.c2s.play.SelectMerchantTradeC2SPacket(index));
   }
   if(skill.equals("rename")){
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.AnvilScreenHandler anvil))throw new TaskRuntime.Rejected("station_required");
    var input=anvil.getSlot(0).getStack();if(input.isEmpty())throw new TaskRuntime.Rejected("input_missing");
    if(!anvil.getSlot(1).getStack().isEmpty())throw new TaskRuntime.Rejected("rename_requires_single_input");
    if(!anvil.getCursorStack().isEmpty())throw new TaskRuntime.Rejected("cursor_not_empty");
    renameName=args.get("name").getAsString();
    if(!renameName.equals(net.minecraft.util.StringHelper.stripInvalidChars(renameName)))throw new TaskRuntime.Rejected("name_characters_unsupported");
    if(net.minecraft.util.StringHelper.isBlank(renameName))renameName="";
    var custom=input.get(net.minecraft.component.DataComponentTypes.CUSTOM_NAME);
    renameUnchanged=renameName.isEmpty()?custom==null:input.getName().getString().equals(renameName);
    targetSlot=renameUnchanged?0:2;outputItem=Registries.ITEM.getId(input.getItem()).toString();beforeCount=count(outputItem);startExperience=c.player.experienceLevel;
    inventoryProof=new InventoryEvidence(beforeCount,anvil.getRevision());
    if(renameUnchanged){craftPhase=1;mutationTick=0;}
    else{
     renameBoundary=InventoryReceipts.CURRENT.cursor();anvil.setNewItemName(renameName);
     c.player.networkHandler.sendPacket(new net.minecraft.network.packet.c2s.play.RenameItemC2SPacket(renameName));
    }
   }
   if(skill.equals("eat")){targetSlot=foodSlot();if(targetSlot<0)throw new TaskRuntime.Rejected("food_missing");c.player.getInventory().selectedSlot=targetSlot;beforeCount=c.player.getMainHandStack().getCount();if(!c.player.canConsume(c.player.getMainHandStack().get(net.minecraft.component.DataComponentTypes.FOOD).canAlwaysEat()))throw new TaskRuntime.Rejected("not_hungry");}
   if(skill.equals("useItem")){c.player.getInventory().selectedSlot=args.get("slot").getAsInt();beforeCount=c.player.getMainHandStack().getCount();outputItem=Registries.ITEM.getId(c.player.getMainHandStack().getItem()).toString();}
   if(skill.equals("inventory")||skill.equals("workstation")){
    if(skill.equals("inventory")&&c.currentScreen==null)c.setScreen(new InventoryScreen(c.player));
    ownedScreen=c.currentScreen;
    if(!screenName().equals(args.get("screen").getAsString()))throw new TaskRuntime.Rejected("screen_changed");
    inventoryProof=new InventoryEvidence(0,c.player.currentScreenHandler.getRevision());
   }
   if(skill.equals("waitFor")&&args.get("area").getAsString().equals("screen")&&StationOutputs.indices(screenName()).isEmpty())throw new TaskRuntime.Rejected("station_required");
   if(skill.equals("craft")){
    var recipe=c.world.getRecipeManager().get(identifier(args,"recipe")).orElseThrow(()->new TaskRuntime.Rejected("recipe_unknown"));
    if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.CraftingScreenHandler||c.player.currentScreenHandler instanceof net.minecraft.screen.PlayerScreenHandler))throw new TaskRuntime.Rejected("station_required");
    if(!c.player.getRecipeBook().contains(recipe))throw new TaskRuntime.Rejected("recipe_unknown");
    var grid=(net.minecraft.screen.AbstractRecipeScreenHandler<?,?>)c.player.currentScreenHandler;
    if(!(recipe.value() instanceof net.minecraft.recipe.CraftingRecipe)||!recipe.value().fits(grid.getCraftingWidth(),grid.getCraftingHeight()))throw new TaskRuntime.Rejected("station_required");
    var output=recipe.value().getResult(c.world.getRegistryManager());outputItem=Registries.ITEM.getId(output.getItem()).toString();beforeCount=count(outputItem);
    if(!c.player.currentScreenHandler.getCursorStack().isEmpty())throw new TaskRuntime.Rejected("cursor_not_empty");
    inventoryProof=new InventoryEvidence(beforeCount,c.player.currentScreenHandler.getRevision());
    if(c.currentScreen==null)c.setScreen(new InventoryScreen(c.player));ownedScreen=c.currentScreen;
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
     if(entity.squaredDistanceTo(c.player)>4096)return TaskRuntime.Step.failed("target_lost");
     if(FollowDuration.complete(ticks,args.has("ticks")?args.get("ticks").getAsInt():null))return done(Map.of("entityId",entity.getId(),"distance",Math.sqrt(entity.squaredDistanceTo(c.player)),"elapsedGameTicks",ticks,"nearby",entity.squaredDistanceTo(c.player)<9));
     if(entity.squaredDistanceTo(c.player)<9){stopSwimming();haltNavigation();break;}
     if(!swimToward(entity,entity.getEyePos()))approach(entity.getBlockPos(),20);break;
    case "mine":
     var mined=BlockReceipts.CURRENT.after(c.world,pos.getX(),pos.getY(),pos.getZ(),blockBoundary);
     if(mined!=null&&!mined.block().equals(beforeBlock)){
      BlockReceipts.CURRENT.claimMine(c.world,c.player.getUuidAsString(),c.world.getRegistryKey().getValue().toString(),pos.getX(),pos.getY(),pos.getZ(),blockBoundary,beforeBlock);
      return done(Map.of("block",beforeState,"x",pos.getX(),"y",pos.getY(),"z",pos.getZ(),"after",mined.state(),"serverBlockSeq",mined.seq(),"serverObservedAt",mined.observedAt()));
     }
     if(!Registries.BLOCK.getId(c.world.getBlockState(pos).getBlock()).toString().equals(beforeBlock)){
      if(predictedChangeTick==0)predictedChangeTick=ticks;
      if(ticks-predictedChangeTick>100)return TaskRuntime.Step.failed("server_confirmation_missing");
      break;
     }
     if(predictedChangeTick!=0&&mined!=null)return TaskRuntime.Step.failed("block_change_rejected");
     if(protectSupport&&belowFeet(pos))return TaskRuntime.Step.failed("unreachable");
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
     if(protectSupport&&belowFeet(pos))return TaskRuntime.Step.failed("unreachable");
     var miningHit=sightHit(pos);if(miningHit==null)return TaskRuntime.Step.failed("target_not_visible");
     look(miningHit.getPos());
     if(!PreparedMineSkill.heldSuitable(c,pos))throw new TaskRuntime.Rejected("tool_required");
     c.interactionManager.updateBlockBreakingProgress(pos,miningHit.getSide());c.player.swingHand(Hand.MAIN_HAND);break;
    case "place":
     var built=BlockReceipts.CURRENT.after(c.world,placed.getX(),placed.getY(),placed.getZ(),blockBoundary);
     if(placeSent&&built!=null&&!built.state().equals(beforeState)){
      var actual=Registries.BLOCK.get(Identifier.of(built.block()));
      if(PlacementEvidence.matches(placedItem,Registries.ITEM.getId(actual.asItem()).toString(),actual.getDefaultState().isAir(),built.seq(),blockBoundary)){
       if(actual instanceof net.minecraft.block.AbstractSignBlock&&ticks-mutationTick<4)break;
       return done(Map.of("x",placed.getX(),"y",placed.getY(),"z",placed.getZ(),"block",built.state(),"serverBlockSeq",built.seq()));
      }
     }
     if(placementWindow(c.currentScreen)){if(ticks-mutationTick>100)return TaskRuntime.Step.failed("server_confirmation_missing");break;}
     if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
     if(++phase>100)return TaskRuntime.Step.failed(built==null&&placeSent?"server_confirmation_missing":"placement_blocked_or_material_missing");
     if(ticks%6==1){var hit=BlockSight.hit(c,pos,direction(args));if(hit==null)return TaskRuntime.Step.failed("target_not_visible");if(!new ItemPlacementContext(c.player,Hand.MAIN_HAND,c.player.getMainHandStack(),hit).getBlockPos().equals(placed))return TaskRuntime.Step.failed(placeSent?"server_confirmation_missing":"placement_blocked_or_material_missing");look(hit.getPos());if(!placeSent){blockBoundary=BlockReceipts.CURRENT.cursor();slotBoundary=InventoryReceipts.CURRENT.cursor();mutationTick=ticks;placeSent=true;}c.interactionManager.interactBlock(c.player,Hand.MAIN_HAND,hit);c.player.swingHand(Hand.MAIN_HAND);}break;
    case "interactBlock":
     if(phase==0){
      if(!reachable(pos)){approach(pos,20);break;}haltNavigation();
      var hit=sightHit(pos);if(hit==null)return TaskRuntime.Step.failed("target_not_visible");look(hit.getPos());
      beginInteraction(-1);c.interactionManager.interactBlock(c.player,Hand.MAIN_HAND,hit);interaction.confirmWindow(c.currentScreen);
     }
     return interactionResult();
    case "interactEntity":
     if(phase==0){
      if(!entity.isAlive())return TaskRuntime.Step.failed("target_lost");
      if(!visibleApproach())break;
      if(entity.squaredDistanceTo(c.player)>9){if(!swimToward(entity,entity.getEyePos()))approach(entity.getBlockPos(),20);break;}stopSwimming();haltNavigation();
      look(entity.getEyePos());beginInteraction(entity.getId());c.interactionManager.interactEntity(c.player,entity,Hand.MAIN_HAND);interaction.confirmWindow(c.currentScreen);
     }
     return interactionResult();
    case "pickup":
     var receipt=PickupLedger.CURRENT.since(c.world,args.get("entityId").getAsInt(),c.player.getId(),pickupBoundary);
     if(receipt!=null)return done(Map.of("entityId",receipt.entityId(),"pickedCount",receipt.amount(),"serverPickupSeq",receipt.seq()));
     if(entity==null||entity.isRemoved())return TaskRuntime.Step.failed("drop_gone_without_own_pickup");
     if(!visibleApproach())break;
     PickupCapacity.require(PickupCapacity.room(c.player.getInventory(),((net.minecraft.entity.ItemEntity)entity).getStack()));
     if(swimToward(entity,entity.getPos())){if(++lostTicks>200)return TaskRuntime.Step.failed("unreachable");break;}
     if(navigating&&navigation.arrived()&&pathTarget.equals(entity.getBlockPos())){haltNavigation();phase=1;}
     if(phase>0){
      look(entity.getPos());c.options.forwardKey.setPressed(false);c.options.jumpKey.setPressed(false);
      if(!pathTarget.equals(entity.getBlockPos())){phase=0;approach(entity.getBlockPos(),20);}
      else if(++phase>40)return TaskRuntime.Step.failed("unreachable");
     }else approach(entity.getBlockPos(),20);
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
    case "rename":
     if(!(c.player.currentScreenHandler instanceof net.minecraft.screen.AnvilScreenHandler anvil))return TaskRuntime.Step.failed("station_screen_changed");
     if(craftPhase==0){
      var output=anvil.getSlot(2).getStack();var custom=output.get(net.minecraft.component.DataComponentTypes.CUSTOM_NAME);
      var changes=InventoryReceipts.CURRENT.changes(proofWorld,proofHandler,renameBoundary);
      if(!output.isEmpty()&&RenameProof.matches(renameName,custom==null?"":custom.getString(),SlotConfirmation.fingerprint(output),changes)){
       if(!c.player.getAbilities().creativeMode&&anvil.getLevelCost()>c.player.experienceLevel)return TaskRuntime.Step.failed("levels_required");
       craftPhase=1;mutationTick=ticks;
      }else if(ticks>100)return TaskRuntime.Step.failed(changes.containsKey(2)?"rename_unavailable":"server_confirmation_missing");
     }
     if(craftPhase>=1){
      if(gainSettled()){
       var evidence=new LinkedHashMap<String,Object>(gainReceipt());evidence.put("name",renameName);evidence.put("unchanged",renameUnchanged);evidence.put("experienceBefore",startExperience);evidence.put("experienceAfter",c.player.experienceLevel);return done(evidence);
      }
      if(craftPhase==1&&!roomFor(anvil.getSlot(targetSlot).getStack()))return TaskRuntime.Step.failed("inventory_full");
      takeOneOutput(targetSlot);
      if(ticks-mutationTick>100)return TaskRuntime.Step.failed("server_confirmation_missing");
     }
     break;
    case "attack": return combat();
    case "eat":
     if(c.player.getHungerManager().getFoodLevel()>startFood||c.player.getMainHandStack().getCount()<beforeCount)return done(Map.of("foodBefore",startFood,"foodAfter",c.player.getHungerManager().getFoodLevel(),"remaining",c.player.getMainHandStack().getCount()));
     c.options.useKey.setPressed(true);
     if(ticks%4==1&&!c.player.isUsingItem())c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);break;
    case "useItem":
     if(interaction!=null&&interaction.interrupted())return TaskRuntime.Step.failed("server_confirmation_missing");
     c.options.useKey.setPressed(c.player.getMainHandStack().getUseAction()!=net.minecraft.util.UseAction.NONE);
     if(ticks==1){beginInteraction(-2);c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);interaction.confirmWindow(c.currentScreen);}
     if(c.currentScreen!=null&&interaction.ownsWindow(c.currentScreen,c.player.currentScreenHandler.syncId,interactionServerContainer(c.currentScreen),false,false)){c.options.useKey.setPressed(false);return interactionResult();}
     if(outputItem.equals("minecraft:written_book")||outputItem.equals("minecraft:writable_book")){if(ticks-mutationTick>80)return TaskRuntime.Step.failed("server_confirmation_missing");break;}
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
     if(craftPhase==0){c.interactionManager.clickRecipe(c.player.currentScreenHandler.syncId,c.world.getRecipeManager().get(identifier(args,"recipe")).orElseThrow(()->new TaskRuntime.Rejected("recipe_unknown")),false);mutationTick=ticks;craftPhase=1;}
     else takeOneOutput(0);
     if(ticks-mutationTick>100)return TaskRuntime.Step.failed("ingredients_station_or_server_ack_missing");break;
    case "closeScreen":if(c.currentScreen==null)return done(Map.of("screen","world"));break;
    default: return TaskRuntime.Step.failed("unsupported_skill");
   }
   return TaskRuntime.Step.running();
  }
  private OptionalInt outputDestination(ItemStack output){
   if(output.isEmpty())return OptionalInt.empty();
   var slots=c.player.currentScreenHandler.slots.stream().map(slot->new ItemSelection.OutputSlot(slot.id,
    slot.inventory==c.player.getInventory()&&slot.getIndex()>=0&&slot.getIndex()<36,slot.canInsert(output),
    ItemStack.areItemsAndComponentsEqual(slot.getStack(),output),slot.getStack().getCount(),slot.getMaxItemCount(output))).toList();
   return ItemSelection.output(slots,output.getCount());
  }
  private boolean roomFor(ItemStack output){return outputDestination(output).isPresent();}
  private void takeOneOutput(int outputSlot){
   if(craftPhase==1&&ticks-mutationTick>=4&&!c.player.currentScreenHandler.getSlot(outputSlot).getStack().isEmpty()){
      if(!roomFor(c.player.currentScreenHandler.getSlot(outputSlot).getStack()))throw new TaskRuntime.Rejected("inventory_full");
      // Pickup exactly one recipe output, rather than shift-crafting every available ingredient.
      verifiedClick(outputSlot,0,SlotActionType.PICKUP);craftPhase=2;
     }else if(craftPhase==2&&ticks-mutationTick>=3&&!c.player.currentScreenHandler.getCursorStack().isEmpty()){
      var cursor=c.player.currentScreenHandler.getCursorStack();
      var destination=outputDestination(cursor);
      if(destination.isEmpty())throw new TaskRuntime.Rejected("inventory_full");
      verifiedClick(destination.getAsInt(),0,SlotActionType.PICKUP);inventoryProof.mutated(ticks,c.player.currentScreenHandler.getRevision());craftPhase=3;
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
   var damage=c.player.getRecentDamageSource();
   boolean recentAttacker=ThreatPolicy.recent(c.player.getAttacker()==entity,c.player.age-c.player.getLastAttackedTime(),damage!=null&&damage.getAttacker()==entity);
   boolean dangerous=entity instanceof net.minecraft.entity.player.PlayerEntity||entity instanceof net.minecraft.entity.mob.Monster||entity instanceof net.minecraft.entity.mob.Angerable
    ||entity instanceof net.minecraft.entity.mob.MobEntity mob&&(mob.isAttacking()||mob.getTarget()==c.player)||recentAttacker;
   String retreat=withdrawal.update(c.player.getHealth(),entity.squaredDistanceTo(c.player),ticks,ThreatRange.ranged(entity),dangerous);
   if(!retreat.isEmpty()){
    haltNavigation();
    if(!retreat.equals("retreating"))return TaskRuntime.Step.failed(retreat);
    c.options.useKey.setPressed(false);c.options.attackKey.setPressed(false);
    if(c.player.isUsingItem())c.interactionManager.stopUsingItem(c.player);
    escape.drive(c,point->point.squaredDistanceTo(entity.getPos()));return TaskRuntime.Step.running();
   }
   double distance=entity.squaredDistanceTo(c.player);
   var item=c.player.getMainHandStack().getItem();
   boolean ranged=item instanceof BowItem||item instanceof CrossbowItem||item instanceof TridentItem;
   c.options.useKey.setPressed(false);
   boolean readyStrike=!ranged&&c.player.canInteractWithEntity(entity,0)&&c.player.getAttackCooldownProgress(0)>=.95;
   boolean windingUp=entity instanceof LivingEntity living&&(living.isUsingItem()||living.handSwinging||distance<8);
   boolean incoming=!ranged&&c.world.getEntitiesByClass(net.minecraft.entity.projectile.ProjectileEntity.class,c.player.getBoundingBox().expand(18),projectile->projectile.getOwner()!=c.player&&projectile.getVelocity().lengthSquared()>.01&&projectile.getVelocity().dotProduct(c.player.getEyePos().subtract(projectile.getPos()))>0&&c.player.canSee(projectile)).stream().anyMatch(projectile->{
    var relative=projectile.getPos().subtract(c.player.getPos().add(0,.9,0));var velocity=projectile.getVelocity();double time=-relative.dotProduct(velocity)/velocity.lengthSquared();return time>0&&time<12&&relative.add(velocity.multiply(time)).lengthSquared()<4;
   });
   shield(ProjectileAim.block(c.player.getOffHandStack().isOf(Items.SHIELD)&&!ranged,windingUp,incoming,readyStrike));
   if(distance>(ranged?225:8)){if(!swimToward(entity,entity.getEyePos()))approach(entity.getBlockPos(),10);return TaskRuntime.Step.running();}
   stopSwimming();haltNavigation();
   if(ranged){
    var delta=entity.getBoundingBox().getCenter().subtract(c.player.getEyePos());var velocity=entity.getVelocity();
    var solution=ProjectileAim.solve(delta.x,delta.y,delta.z,velocity.x,velocity.y,velocity.z,item instanceof CrossbowItem?3.15:item instanceof TridentItem?2.5:3,.05);
    if(solution.isEmpty())return TaskRuntime.Step.failed("shot_unreachable");
    var shot=solution.get();var aim=new Vec3d(shot.x(),shot.y(),shot.z());look(c.player.getEyePos().add(aim));
    boolean aligned=c.player.getRotationVec(1).dotProduct(aim.normalize())>.996;
    var stack=c.player.getMainHandStack();
    if(item instanceof CrossbowItem&&CrossbowItem.isCharged(stack)){if(aligned){c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);startedUse=false;}}
    else{
     if((item instanceof BowItem||item instanceof CrossbowItem)&&!c.player.getAbilities().creativeMode&&c.player.getProjectileType(stack).isEmpty())return TaskRuntime.Step.failed("ammunition_missing");
     c.options.useKey.setPressed(true);
     if(!c.player.isUsingItem()&&!startedUse){c.interactionManager.interactItem(c.player,Hand.MAIN_HAND);startedUse=true;phase=0;}
     if(startedUse&&++phase>=28&&aligned){c.options.useKey.setPressed(false);c.interactionManager.stopUsingItem(c.player);startedUse=false;}
    }
   }
   else {look(entity.getEyePos());if(readyStrike){shield(false);c.interactionManager.attackEntity(c.player,entity);c.player.swingHand(Hand.MAIN_HAND);}}
   return TaskRuntime.Step.running();
  }
  private void shield(boolean blocking){
   c.options.useKey.setPressed(blocking);
   if(blocking){if(!c.player.isUsingItem())c.interactionManager.interactItem(c.player,Hand.OFF_HAND);}
   else if(c.player.isUsingItem()&&c.player.getActiveHand()==Hand.OFF_HAND)c.interactionManager.stopUsingItem(c.player);
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
  private boolean visibleApproach(){
   boolean visible=c.player.canSee(entity);lastSeen=seenTarget.sample(visible,()->entity.getBlockPos());
   if(seenTarget.lost())throw new TaskRuntime.Rejected("target_lost");
   if(visible)return true;
   stopSwimming();if(c.player.squaredDistanceTo(lastSeen.toCenterPos())>4)approach(lastSeen,20);else{haltNavigation();look(lastSeen.toCenterPos());}
   return false;
  }
  private boolean swimToward(Entity target,Vec3d lookAt){
   if(!c.player.canSee(target)){stopSwimming();return false;}
   var delta=target.getPos().subtract(c.player.getPos());
   var motion=WaterApproach.swim(c.player.isTouchingWater(),target.isTouchingWater(),c.player.canSee(target),delta.x,delta.y,delta.z);
   if(!motion.steer()){stopSwimming();return false;}
   haltNavigation();swimming=true;look(lookAt);
   c.options.forwardKey.setPressed(motion.forward());c.options.jumpKey.setPressed(motion.up());c.options.sneakKey.setPressed(motion.down());
   return true;
  }
  private void stopSwimming(){if(swimming){c.options.forwardKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.sneakKey.setPressed(false);swimming=false;}}
  private void go(BlockPos target){
   boolean navigate=skill.equals("navigate");
   boolean surface=navigate&&args.has("height")&&args.get("height").getAsString().equals("surface");
   // Long water approaches use the collision-aware surface route; the short
   // visible approach handles vertical swimming once the target is nearby.
   if(!navigate&&entity!=null&&c.player.canSee(entity)&&WaterApproach.surfaceRoute(c.player.isTouchingWater(),entity.isTouchingWater()))surface=true;
   boolean adapt=navigate&&args.has("terrain")&&args.get("terrain").getAsString().equals("adapt");
   // Exact navigation names the feet block. Interaction approaches may stop
   // nearby, but must not make a different floor count as an exact arrival.
   if(Set.of("mine","place","interactBlock").contains(skill))navigation.startInteraction(target);
   else navigation.start(target.getX(),target.getY(),target.getZ(),surface,navigate||skill.equals("pickup"),adapt);
   navigating=true;pathTarget=target;
  }
  private void approach(BlockPos target,int interval){
   boolean settled=navigating&&(navigation.arrived()||navigation.failed());
   if(NavigationBounds.retarget(navigating,settled,navigating?pathTarget.getSquaredDistance(target):0,ticks%interval==1)){haltNavigation();go(target);}
   else if(settled)throw new TaskRuntime.Rejected("unreachable");
  }
  private void haltNavigation(){if(navigating){navigation.stop();navigating=false;}}
  private RaycastContext.ShapeType sightShape(BlockPos target){return c.world.getBlockState(target).getCollisionShape(c.world,target).isEmpty()?RaycastContext.ShapeType.OUTLINE:RaycastContext.ShapeType.COLLIDER;}
  private BlockHitResult sightHit(BlockPos target){
   return BlockSight.hit(c,target,null,observedPoint);
  }
  private boolean visible(BlockPos target){return sightHit(target)!=null;}
  private boolean reachable(BlockPos target){return c.player.canInteractWithBlockAt(target,0)&&(!(c.world.getBlockState(target).getBlock() instanceof net.minecraft.block.BedBlock)||InteractionReach.bedWithin(c.player.getX(),c.player.getY(),c.player.getZ(),target.getX(),target.getY(),target.getZ()))&&visible(target);}
  private Direction face(BlockPos target){var hit=sightHit(target);if(hit==null)throw new TaskRuntime.Rejected("target_not_visible");return hit.getSide();}
  private void look(Vec3d target){var delta=target.subtract(c.player.getEyePos());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z)),pitch=(float)-Math.toDegrees(Math.atan2(delta.y,Math.sqrt(delta.x*delta.x+delta.z*delta.z)));c.player.setYaw(c.player.getYaw()+MathHelper.clamp(MathHelper.wrapDegrees(yaw-c.player.getYaw()),-18,18));c.player.setPitch(c.player.getPitch()+MathHelper.clamp(pitch-c.player.getPitch(),-14,14));}
  private int foodSlot(){return FoodInventory.find(c,9);}
  private int count(String item){int n=0;for(int i=0;i<c.player.getInventory().size();i++){var stack=c.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(item))n+=stack.getCount();}return n;}
  private String inventoryState(){StringBuilder value=new StringBuilder();for(var slot:c.player.currentScreenHandler.slots){var stack=slot.getStack();if(!stack.isEmpty())value.append(slot.id).append(':').append(Registries.ITEM.getId(stack.getItem())).append('*').append(stack.getCount()).append('@').append(stack.getComponents().hashCode()).append(';');}return value.append("cursor:").append(c.player.currentScreenHandler.getCursorStack()).toString();}
  private int handScreenSlot(){
   for(var slot:c.player.currentScreenHandler.slots)if(slot.inventory==c.player.getInventory()&&slot.getIndex()==c.player.getInventory().selectedSlot)return slot.id;
   return -1;
  }
  private boolean sleepingAtTarget(){
   if(pos==null||!c.player.isSleeping())return false;
   var bed=c.player.getSleepingPosition().orElse(null);if(bed==null)return false;if(bed.equals(pos))return true;
   var state=c.world.getBlockState(pos);if(!(state.getBlock() instanceof net.minecraft.block.BedBlock))return false;
   var facing=state.get(net.minecraft.block.BedBlock.FACING);
   var other=pos.offset(state.get(net.minecraft.block.BedBlock.PART)==net.minecraft.block.enums.BedPart.HEAD?facing.getOpposite():facing);
   return bed.equals(other);
  }
  private InteractionOutcome.State interactionState(){
   var handler=c.player.currentScreenHandler;var stack=c.player.getMainHandStack();
   var snapshot=InventoryReceipts.CURRENT.after(c.world,handler.syncId,0);
   var block=pos==null?null:BlockReceipts.CURRENT.after(c.world,pos.getX(),pos.getY(),pos.getZ(),blockBoundary);
   String blockState=pos==null?"":block==null?c.world.getBlockState(pos).toString():block.state();
   var hand=new InteractionOutcome.Hand(Registries.ITEM.getId(stack.getItem()).toString(),stack.getCount(),stack.getDamage(),handScreenSlot());
   String confirmed=interaction!=null&&targetSlot>=0&&interaction.handCandidate(hand,handler.syncId)?InventoryReceipts.CURRENT.changes(c.world,proofHandler,slotBoundary).get(targetSlot):null;
   boolean heldConfirmed=confirmed!=null&&confirmed.equals(SlotConfirmation.fingerprint(stack));
   return new InteractionOutcome.State(c.currentScreen,handler.syncId,interactionServerContainer(c.currentScreen),snapshot==null?0:snapshot.sequence(),blockState,block==null?0:block.seq(),c.player.getVehicle()==null?-1:c.player.getVehicle().getId(),sleepingAtTarget(),hand,heldConfirmed);
  }
  private boolean interactionServerContainer(Object screen){
   if(interaction==null||interaction.interrupted()||c.world!=proofWorld)return false;
   var opened=InventoryReceipts.CURRENT.windowAfter(c.world,screen,slotBoundary);if(opened==null)return false;
   int handler=c.player.currentScreenHandler.syncId;
   boolean container=screen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?> &&opened.handler()==handler;
   if(container&&opened.target().equals("container:"+handler))return true;
   String expected=skill.equals("useItem")?"hand:MAIN_HAND":skill.equals("interactEntity")?"entity:"+args.get("entityId").getAsInt():pos==null?"":"block:"+pos.getX()+","+pos.getY()+","+pos.getZ();
   if(!opened.target().equals(expected))return false;
   if(container)return true;
   interaction.confirmWindow(screen);return false;
  }
  private boolean placementWindow(Object screen){
   if(!skill.equals("place")||!placeSent||placed==null||c.world!=proofWorld)return false;
   var opened=InventoryReceipts.CURRENT.windowAfter(c.world,screen,slotBoundary);
   return opened!=null&&opened.target().equals("block:"+placed.getX()+","+placed.getY()+","+placed.getZ());
  }
  private void beginInteraction(int target){
   ownedScreen=c.currentScreen;proofHandler=c.player.currentScreenHandler.syncId;targetSlot=handScreenSlot();
   slotBoundary=InventoryReceipts.CURRENT.cursor();blockBoundary=BlockReceipts.CURRENT.cursor();mutationTick=ticks;
   interaction=new InteractionOutcome(interactionState(),ticks,slotBoundary,blockBoundary,target);phase=1;
  }
  private TaskRuntime.Step interactionResult(){
   if(interaction.interrupted())return TaskRuntime.Step.failed("server_confirmation_missing");
   var state=interactionState();String effect=interaction.effect(state,ticks);
   if(!effect.isEmpty())return done(interactionEvidence(state,effect));
   return ticks-mutationTick>80?TaskRuntime.Step.failed("server_confirmation_missing"):TaskRuntime.Step.running();
  }
  private Map<String,Object> interactionEvidence(InteractionOutcome.State state,String effect){
    var proof=new LinkedHashMap<String,Object>();proof.put("effect",effect);
    if(skill.equals("interactEntity"))proof.put("entityId",args.get("entityId").getAsInt());
    else if(skill.equals("interactBlock")){proof.put("x",pos.getX());proof.put("y",pos.getY());proof.put("z",pos.getZ());}
    else proof.put("item",outputItem);
    if(effect.equals("mounted_target"))proof.put("vehicleId",state.vehicle());
    if(effect.equals("sleeping"))proof.put("sleepingAtTarget",true);
    if(effect.equals("block_changed")){proof.put("block",state.block());proof.put("serverBlockSeq",state.blockSeq());}
    if(effect.equals("screen_opened")){proof.put("screen",screenName());if(state.inventorySeq()>slotBoundary)proof.put("serverSnapshotSeq",state.inventorySeq());var opened=InventoryReceipts.CURRENT.windowAfter(c.world,state.window(),slotBoundary);if(opened!=null){proof.put("serverWindowSeq",opened.sequence());proof.put("windowTarget",opened.target());}}
    if(effect.equals("held_item_changed")){proof.put("item",state.hand().item());proof.put("countAfter",state.hand().count());proof.put("damageAfter",state.hand().damage());proof.put("serverConfirmed",true);}
    return Map.copyOf(proof);
  }
  private void captureInteractionEvidence(){
   if(interaction!=null&&!interaction.interrupted()&&c.player!=null&&c.world==proofWorld){
    var state=interactionState();String effect=interaction.effect(state,ticks);
    if(!effect.isEmpty())verifiedGain=interactionEvidence(state,effect);
   }
  }
  private String screenName(){return GameObservation.screenId(c.player.currentScreenHandler);}
  public void pause(){captureInteractionEvidence();if(interaction!=null)interaction.invalidate();haltNavigation();release();}
  private boolean belowFeet(BlockPos target){if(c.player==null||target==null)return true;var box=c.player.getBoundingBox();return GatherSight.belowFeet(target.getX(),target.getY(),target.getZ(),box.minX,box.minZ,box.maxX,box.maxZ,c.player.getY());}
  public boolean controlsMining(){return skill.equals("mine")&&!navigating&&(!protectSupport||!belowFeet(pos));}
  public boolean handlesCombat(){return skill.equals("attack");}
  public boolean retrySafe(String reason){return Set.of("navigate","follow","wait","waitFor").contains(skill)||Set.of("target_not_visible","outside_known_terrain","block_change_rejected").contains(reason);}
  public Map<String,Object> partialEvidence(){
   captureInteractionEvidence();
   if(c.player!=null&&inventoryProof!=null&&outputItem!=null&&gainSettled())return gainReceipt();
   return !verifiedSlots.isEmpty()?verifiedSlots:verifiedGain;
  }
  public void resume(){if(Set.of("inventory","workstation","craft","trade","waitFor","rename").contains(skill)&&c.currentScreen!=ownedScreen)throw new IllegalStateException("station_screen_changed");if(skill.equals("navigate"))go(pos);}
  public void stop(){haltNavigation();release();}
  private void release(){escape.reset();if(c.interactionManager!=null){c.interactionManager.cancelBlockBreaking();if(c.player!=null&&c.player.isUsingItem())c.interactionManager.stopUsingItem(c.player);}c.options.forwardKey.setPressed(false);c.options.backKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.sneakKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.attackKey.setPressed(false);c.options.useKey.setPressed(false);}
  public Map<String,Object> progress(){return Map.of("skill",skill,"ticks",ticks,"phase",craftPhase);}
  public boolean acceptsScreen(Object screen){return screen==ownedScreen||placementWindow(screen)||interaction!=null&&c.player!=null&&interaction.ownsWindow(screen,c.player.currentScreenHandler.syncId,interactionServerContainer(screen),screen instanceof net.minecraft.client.gui.screen.SleepingChatScreen,sleepingAtTarget());}
 }
}
