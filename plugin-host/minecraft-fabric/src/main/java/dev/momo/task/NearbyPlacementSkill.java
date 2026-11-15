package dev.momo.task;
import com.google.gson.*;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.*;
import net.minecraft.block.ShapeContext;
import net.minecraft.util.Hand;
import net.minecraft.util.math.*;
/** Prepare one block item, find a legal visible local face, then reuse normal placement proof. */
final class NearbyPlacementSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();private final JsonObject args;private TaskRuntime.Work work;
 private List<BlockPos> supports;private int index,phase;private Map<String,Object> prepared=Map.of();
 NearbyPlacementSkill(JsonObject args){this.args=args.deepCopy();}
 public void start(){work=GameSkills.create("selectItem",args);work.start();}
 public TaskRuntime.Step tick(){
  if(work!=null){var result=work.tick();if(!result.state().equals("succeeded"))return result;
   if(phase==2)return TaskRuntime.Step.done(Map.of("preparation",prepared,"placement",result.evidence()));
   prepared=result.evidence();work.stop();work=null;phase=1;
   if(!(c.player.getMainHandStack().getItem() instanceof BlockItem))return TaskRuntime.Step.failed("block_item_required");
   var p=c.player.getBlockPos();supports=new ArrayList<>();for(var b:BlockPos.iterate(p.add(-4,-2,-4),p.add(4,1,4)))supports.add(b.toImmutable());
   supports.sort(Comparator.comparingDouble(b->b.toCenterPos().squaredDistanceTo(c.player.getPos())));
  }
  // At most eight supports / forty bounded face checks per tick. Never a
  // synchronous radius-wide ray scan or discovery of underground resources.
  int budget=8;
  while(index<supports.size()&&budget-->0){var support=supports.get(index++);
   if(!c.world.isChunkLoaded(support)||!c.player.canInteractWithBlockAt(support,0))continue;
   var state=c.world.getBlockState(support);if(state.isAir()||!state.getFluidState().isEmpty())continue;
   for(var face:List.of(Direction.UP,Direction.NORTH,Direction.SOUTH,Direction.EAST,Direction.WEST)){
    var hit=BlockSight.hit(c,support,face);if(hit==null)continue;
    var context=new ItemPlacementContext(c.player,Hand.MAIN_HAND,c.player.getMainHandStack(),hit);var destination=context.getBlockPos();
    if(!context.canPlace()||!c.world.getBlockState(destination).isAir()||new Box(destination).intersects(c.player.getBoundingBox()))continue;
    var block=((BlockItem)c.player.getMainHandStack().getItem()).getBlock();
    if(!c.world.canPlace(block.getDefaultState(),destination,ShapeContext.of(c.player)))continue;
    var place=new JsonObject();place.addProperty("x",support.getX());place.addProperty("y",support.getY());place.addProperty("z",support.getZ());place.addProperty("face",face.getName());place.addProperty("slot",c.player.getInventory().selectedSlot);
    phase=2;work=GameSkills.create("place",place);work.start();return TaskRuntime.Step.running();
   }
  }
  return index>=supports.size()?TaskRuntime.Step.failed("no_visible_placement_space"):TaskRuntime.Step.running();
 }
 public void pause(){if(work!=null)work.pause();}public void resume(){if(work!=null)work.resume();}public void stop(){if(work!=null)work.stop();}
 public boolean acceptsScreen(Object screen){return work!=null&&work.acceptsScreen(screen);}
 public Map<String,Object> progress(){return Map.of("skill","placeNearby","phase",phase,"checkedSupports",index);}
 public Map<String,Object> partialEvidence(){var facts=new LinkedHashMap<String,Object>();if(!prepared.isEmpty())facts.put("preparation",prepared);if(work!=null&&!work.partialEvidence().isEmpty())facts.put("partial",work.partialEvidence());return Map.copyOf(facts);}
}
