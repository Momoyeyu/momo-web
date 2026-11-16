package dev.momo.task;
import baritone.api.*;
import baritone.api.schematic.ISchematic;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.util.*;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;
/** API-only Baritone builder. No file paths, schematic loading, commands or generated code. */
final class BuilderSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();private final SparseBuild plan;
 private final Map<SparseBuild.Cell,BlockState> wanted=new LinkedHashMap<>();private final Map<SparseBuild.Cell,Map<String,Object>> verified=new LinkedHashMap<>();
 private final Map<Settings.Setting<?>,Runnable> settings=new LinkedHashMap<>();private IBaritone baritone;private net.minecraft.client.world.ClientWorld world;
 private long boundary;private int ticks,existing;private boolean started;private final BuildSettlement settlement=new BuildSettlement(20);private final BuildProgress movement=new BuildProgress(200,600);
 private List<Map<String,Object>> blockedCells=List.of(),missingMaterials=List.of();
 BuilderSkill(JsonObject args){plan=SparseBuild.from(args);}
 private <T> void borrow(Settings.Setting<T> setting,T value){T previous=setting.value;settings.putIfAbsent(setting,()->setting.value=previous);setting.value=value;}
 private BlockPos position(SparseBuild.Cell cell){return new BlockPos(cell.x(),cell.y(),cell.z());}
 public void start(){
  blockedCells=missingMaterials=List.of();
  if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");if(c.currentScreen!=null)throw new TaskRuntime.Rejected("close_station_first");world=c.world;boundary=BlockReceipts.CURRENT.cursor();
  var needed=new HashMap<net.minecraft.item.Item,Integer>();var clearing=new LinkedHashSet<net.minecraft.block.Block>();
  for(var cell:plan.cells()){
   var pos=position(cell);if(!world.isChunkLoaded(pos)||pos.getSquaredDistance(c.player.getPos())>1024)throw new TaskRuntime.Rejected("outside_known_terrain");
   var id=Identifier.of(cell.block());if(!Registries.BLOCK.containsId(id))throw new TaskRuntime.Rejected("block_unknown");var desired=Registries.BLOCK.get(id).getDefaultState();
   if(desired.getBlock().asItem()==Items.AIR)throw new TaskRuntime.Rejected("block_not_placeable");wanted.put(cell,desired);var actual=world.getBlockState(pos);
   boolean visible=actual.isAir()?world.raycast(new RaycastContext(c.player.getEyePos(),pos.toCenterPos(),RaycastContext.ShapeType.COLLIDER,RaycastContext.FluidHandling.ANY,c.player)).getType()==HitResult.Type.MISS:BlockSight.hit(c,pos)!=null;
   if(!visible)throw new TaskRuntime.Rejected("build_cells_not_visible");
   if(actual.isOf(desired.getBlock())){verified.put(cell,proof(cell,actual.toString(),0));existing++;}
   else {if(!actual.isAir()){if(!actual.isReplaceable()||!actual.getFluidState().isEmpty()){
    // This state is disclosed only after the preceding normal sight check.
    blockedCells=List.of(Map.of("x",cell.x(),"y",cell.y(),"z",cell.z(),"requested",cell.block(),"actual",Registries.BLOCK.getId(actual.getBlock()).toString(),"observedAt",System.currentTimeMillis()));
    throw new TaskRuntime.Rejected("build_target_occupied");
   }clearing.add(actual.getBlock());}needed.merge(desired.getBlock().asItem(),1,Integer::sum);}
  }
  var shortages=new ArrayList<Map<String,Object>>();
  for(var entry:needed.entrySet()){int count=0;for(int i=0;i<36;i++)if(c.player.getInventory().getStack(i).isOf(entry.getKey()))count+=c.player.getInventory().getStack(i).getCount();if(count<entry.getValue())shortages.add(Map.of("item",Registries.ITEM.getId(entry.getKey()).toString(),"required",entry.getValue(),"available",count,"missing",entry.getValue()-count));}
  missingMaterials=List.copyOf(shortages);if(!missingMaterials.isEmpty())throw new TaskRuntime.Rejected("materials_missing");
  if(verified.size()==wanted.size())return;
  baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
  if(baritone.getPathingBehavior().isPathing()||baritone.getBuilderProcess().isActive()||baritone.getCustomGoalProcess().isActive()||baritone.getPathingControlManager().mostRecentInControl().filter(p->p.isActive()).isPresent())throw new TaskRuntime.Rejected("body_already_owned");
  var s=BaritoneAPI.getSettings();borrow(s.allowBreak,false);borrow(s.allowBreakAnyway,List.copyOf(clearing));borrow(s.allowPlace,true);borrow(s.allowInventory,true);borrow(s.allowParkourPlace,false);borrow(s.allowWaterBucketFall,false);borrow(s.chunkCaching,false);
  borrow(s.chatControl,false);borrow(s.chatControlAnyway,false);borrow(s.prefixControl,false);borrow(s.renderPath,false);borrow(s.renderGoal,false);
  borrow(s.buildIgnoreExisting,false);borrow(s.buildOnlySelection,false);borrow(s.buildInLayers,false);borrow(s.buildRepeat,Vec3i.ZERO);borrow(s.buildRepeatCount,1);borrow(s.buildRepeatSneaky,false);
  borrow(s.buildIgnoreBlocks,List.of());borrow(s.buildSkipBlocks,List.of());borrow(s.buildSubstitutes,Map.of());borrow(s.buildValidSubstitutes,Map.of());borrow(s.buildSchematicRotation,BlockRotation.NONE);borrow(s.buildSchematicMirror,BlockMirror.NONE);
  // The public blueprint requests block types. Connection/orientation properties
  // come from normal placement; a default isolated fence is not a material type.
  borrow(s.buildIgnoreDirection,true);borrow(s.buildIgnoreProperties,wanted.values().stream().flatMap(state->state.getProperties().stream()).map(property->property.getName()).distinct().toList());
  borrow(s.schematicOrientationX,false);borrow(s.schematicOrientationY,false);borrow(s.schematicOrientationZ,false);borrow(s.startAtLayer,0);
  started=true;
  baritone.getBuilderProcess().build("momo",new ISchematic(){
   public int widthX(){return plan.width();}public int heightY(){return plan.height();}public int lengthZ(){return plan.length();}
   public boolean inSchematic(int x,int y,int z,BlockState current){return plan.local(x,y,z)!=null;}
   public BlockState desiredState(int x,int y,int z,BlockState current,List<BlockState> placeable){var cell=plan.local(x,y,z);if(cell==null)return current;var desired=wanted.get(cell);return current.isOf(desired.getBlock())?current:desired;}
  },new Vec3i(plan.x(),plan.y(),plan.z()));
 }
 private Map<String,Object> proof(SparseBuild.Cell cell,String state,long seq){var value=new LinkedHashMap<String,Object>();value.put("x",cell.x());value.put("y",cell.y());value.put("z",cell.z());value.put("block",state);if(seq>0)value.put("serverBlockSeq",seq);else value.put("observedExisting",true);return Map.copyOf(value);}
 public TaskRuntime.Step tick(){
  if(c.world!=world||c.player==null||!c.player.isAlive())return TaskRuntime.Step.failed("world_unavailable");ticks++;
  for(var entry:wanted.entrySet()){
   var cell=entry.getKey();var actual=world.getBlockState(position(cell));if(!actual.isOf(entry.getValue().getBlock())){verified.remove(cell);continue;}
   var receipt=BlockReceipts.CURRENT.after(world,cell.x(),cell.y(),cell.z(),boundary);
   if(receipt!=null&&Registries.BLOCK.get(Identifier.of(receipt.block()))==entry.getValue().getBlock())verified.put(cell,proof(cell,receipt.state(),receipt.seq()));
  }
  if(verified.size()==wanted.size())return TaskRuntime.Step.done(Map.of("engine","baritone","confirmedCells",List.copyOf(verified.values()),"observedExisting",existing));
  if(baritone==null)return TaskRuntime.Step.failed("build_state_changed");
  if(ticks>2400)return TaskRuntime.Step.failed("build_timeout");
  if(settlement.missingReceiptExpired(baritone.getBuilderProcess().isActive()&&!baritone.getBuilderProcess().isPaused()))return TaskRuntime.Step.failed("build_incomplete");
  if(movement.blocked(verified.size(),c.player.getX(),c.player.getY(),c.player.getZ()))return TaskRuntime.Step.failed("build_blocked");
  return TaskRuntime.Step.running();
 }
 private void releaseKeys(){c.options.forwardKey.setPressed(false);c.options.backKey.setPressed(false);c.options.leftKey.setPressed(false);c.options.rightKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.sneakKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.attackKey.setPressed(false);c.options.useKey.setPressed(false);}
 public void pause(){if(started){baritone.getBuilderProcess().pause();borrow(BaritoneAPI.getSettings().allowInventory,false);baritone.getInputOverrideHandler().clearAllKeys();releaseKeys();}}
 public void resume(){if(started){borrow(BaritoneAPI.getSettings().allowInventory,true);baritone.getBuilderProcess().resume();}}
 public void stop(){try{if(started){baritone.getBuilderProcess().onLostControl();baritone.getPathingBehavior().cancelEverything();baritone.getInputOverrideHandler().clearAllKeys();releaseKeys();if(baritone.getBuilderProcess().isActive())throw new IllegalStateException("Builder stop unconfirmed");started=false;}}finally{settings.values().forEach(Runnable::run);settings.clear();}}
 public boolean acceptsScreen(Object screen){return started&&screen instanceof InventoryScreen;}
 public Map<String,Object> progress(){return Map.of("skill","build","engine","baritone","confirmed",verified.size(),"requested",wanted.size(),"ticks",ticks);}
 public Map<String,Object> partialEvidence(){return Map.of("confirmedCells",List.copyOf(verified.values()),"remainingCells",plan.cells().stream().filter(cell->!verified.containsKey(cell)).map(cell->Map.of("x",cell.x(),"y",cell.y(),"z",cell.z(),"block",cell.block())).toList(),"blockedCells",blockedCells,"missingMaterials",missingMaterials);}
}
