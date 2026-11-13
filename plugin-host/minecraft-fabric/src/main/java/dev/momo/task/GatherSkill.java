package dev.momo.task;

import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.Registries;
import net.minecraft.util.hit.*;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;

/** Finite gather loop: ordinary sight rays, existing skills, actual inventory gain. */
public final class GatherSkill implements TaskRuntime.Work {
 private final MinecraftClient c=MinecraftClient.getInstance();
 private final String item;private final int requested;
 private final Map<BlockPos,Integer> blocked=new HashMap<>();
 private TaskRuntime.Work child;private BlockPos target,origin,foliage;
 private int baseline,ticks,scan,idle,clearedLeaves;private String phase="search",lastFailure="";
 public GatherSkill(JsonObject args){item=args.get("item").getAsString();requested=args.get("count").getAsInt();}
 public void start(){if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");if(!Registries.ITEM.containsId(net.minecraft.util.Identifier.of(item)))throw new TaskRuntime.Rejected("item_unknown");if(origin==null){baseline=count();origin=c.player.getBlockPos();}scan=idle=0;lastFailure="";foliage=null;phase="search";}
 private int count(){int total=0;for(int i=0;i<c.player.getInventory().size();i++){var stack=c.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(item))total+=stack.getCount();}return total;}
 public TaskRuntime.Step tick(){
  if(++ticks>2400)return TaskRuntime.Step.failed("gather_timeout");
  if(c.player==null||c.world==null||!c.player.isAlive())return TaskRuntime.Step.failed("world_unavailable");
  if(count()-baseline>=requested)return TaskRuntime.Step.done(Map.of("item",item,"countBefore",baseline,"countAfter",count()));
  if(c.player.getBlockPos().getSquaredDistance(origin)>1024)return TaskRuntime.Step.failed("outside_known_terrain");
  if(child!=null){
   TaskRuntime.Step outcome;
   try{outcome=child.tick();}catch(RuntimeException error){outcome=TaskRuntime.Step.failed(TaskRuntime.reason(error,"execution_failed"));}
   if(outcome.state().equals("running"))return outcome;
   child.stop();child=null;
   if(Set.of("server_confirmation_missing","execution_failed","stop_unconfirmed").contains(outcome.reason()))return outcome;
   if(outcome.state().equals("failed")){lastFailure=outcome.reason();if(target!=null)blocked.put(target,ticks+200);}
   target=null;foliage=null;phase="search";idle=0;scan=0;return TaskRuntime.Step.running();
  }
  // Pickup entities are already visible normal-player facts, not remote loot scans.
  var drop=c.world.getOtherEntities(c.player,c.player.getBoundingBox().expand(16),e->e instanceof net.minecraft.entity.ItemEntity d&&Registries.ITEM.getId(d.getStack().getItem()).toString().equals(item)&&c.player.canSee(e)).stream().min(Comparator.comparingDouble(e->e.squaredDistanceTo(c.player)));
  if(drop.isPresent()){var args=new JsonObject();args.addProperty("entityId",drop.get().getId());begin("pickup",args);return TaskRuntime.Step.running();}
  if(++idle<12)return TaskRuntime.Step.running(); // Allow normal drops/server inventory updates to arrive.
  // At most sixteen sight rays per tick; read only the first visible hit of each.
  for(int n=0;n<16&&scan<512;n++,scan++){
   double[] direction=GatherSight.direction(scan);var eye=c.player.getEyePos();var end=eye.add(direction[0]*16,direction[1]*16,direction[2]*16);
   var hit=c.world.raycast(new RaycastContext(eye,end,RaycastContext.ShapeType.OUTLINE,RaycastContext.FluidHandling.NONE,c.player));
   if(hit.getType()!=HitResult.Type.BLOCK)continue;
   var pos=hit.getBlockPos();if(!c.world.isChunkLoaded(pos)||blocked.getOrDefault(pos,0)>ticks)continue;
   var state=c.world.getBlockState(pos);String block=Registries.BLOCK.getId(state.getBlock()).toString();
   if(!Registries.ITEM.getId(state.getBlock().asItem()).toString().equals(item)&&!GatherSight.normalDrop(block,item)){
    // A visible canopy is a normal cue for wood, not knowledge of a hidden log.
    // Clear only a few reachable leaves if a full sight pass finds no exposed source.
    if(clearedLeaves<8&&item.endsWith("_log")&&block.equals(item.substring(0,item.length()-4)+"_leaves")&&c.player.canInteractWithBlockAt(pos,0)&&(foliage==null||pos.getSquaredDistance(c.player.getPos())<foliage.getSquaredDistance(c.player.getPos())))foliage=pos.toImmutable();
    continue;
   }
   if(state.isToolRequired()){boolean suitable=false;for(int i=0;i<9;i++)if(c.player.getInventory().getStack(i).isSuitableFor(state))suitable=true;if(!suitable){lastFailure="tool_required";blocked.put(pos.toImmutable(),ticks+200);continue;}}
   target=pos.toImmutable();var args=new JsonObject();args.addProperty("x",pos.getX());args.addProperty("y",pos.getY());args.addProperty("z",pos.getZ());begin("mine",args);return TaskRuntime.Step.running();
  }
  if(scan>=512){
   if(foliage!=null){target=foliage;foliage=null;clearedLeaves++;var args=new JsonObject();args.addProperty("x",target.getX());args.addProperty("y",target.getY());args.addProperty("z",target.getZ());begin("mine",args);scan=0;return TaskRuntime.Step.running();}
   return TaskRuntime.Step.failed(lastFailure.isEmpty()?"source_not_visible":lastFailure);
  }
  return TaskRuntime.Step.running();
 }
 private void begin(String skill,JsonObject args){
  child=GameSkills.create(skill,args);phase=skill;
  try{child.start();}catch(RuntimeException error){child.stop();child=null;lastFailure=TaskRuntime.reason(error,"start_failed");if(target!=null)blocked.put(target,ticks+200);target=null;phase="search";}
 }
 public void pause(){if(child!=null)child.pause();}
 public boolean controlsMining(){return child!=null&&child.controlsMining();}
 public boolean retrySafe(String reason){return Set.of("source_not_visible","target_not_visible","tool_required","unreachable").contains(reason);}
 public void resume(){if(child!=null)child.resume();}
 public void stop(){if(child!=null){child.stop();child=null;}}
 public Map<String,Object> partialEvidence(){return c.player==null||count()<=baseline?Map.of():Map.of("item",item,"countBefore",baseline,"countAfter",count());}
 public Map<String,Object> progress(){return Map.of("skill","gather","phase",phase,"item",item,"gained",Math.max(0,count()-baseline),"requested",requested);}
}
