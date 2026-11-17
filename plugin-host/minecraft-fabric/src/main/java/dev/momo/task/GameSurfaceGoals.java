package dev.momo.task;
import baritone.api.pathing.goals.Goal;
import net.minecraft.block.ShapeContext;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.Heightmap;
/** Cached, already-loaded local collision data only; no synchronous chunk scan. */
final class GameSurfaceGoals {
 static Goal create(int x,int z){
  var c=MinecraftClient.getInstance();var world=c.world;var player=c.player;
  if(world==null||player==null)throw new TaskRuntime.Rejected("world_unavailable");
  return SurfaceGoals.create(x,z,new SurfaceGoals.Scene(){
   public boolean ceiling(){return world.getDimension().hasCeiling();}
   public int bottom(){return world.getBottomY();}
   public Integer top(int x,int z){
    var pos=new BlockPos(x,player.getBlockY(),z);if(!world.isChunkLoaded(pos))return null;
    if(!world.getChunk(pos).hasHeightmap(Heightmap.Type.MOTION_BLOCKING))return null;
    return world.getTopY(Heightmap.Type.MOTION_BLOCKING,x,z);
   }
   public SurfaceGoals.Kind kind(int x,int y,int z){
    var pos=new BlockPos(x,y,z);var state=world.getBlockState(pos);
    if(state.isAir())return SurfaceGoals.Kind.AIR;
    if(state.isIn(BlockTags.LEAVES))return SurfaceGoals.Kind.LEAVES;
    if(!state.getCollisionShape(world,pos,ShapeContext.of(player)).isEmpty())return SurfaceGoals.Kind.SOLID;
    var fluid=state.getFluidState();if(fluid.isEmpty())return SurfaceGoals.Kind.AIR;
    return fluid.isIn(FluidTags.WATER)?SurfaceGoals.Kind.WATER:SurfaceGoals.Kind.UNSAFE_FLUID;
   }
  });
 }
}
