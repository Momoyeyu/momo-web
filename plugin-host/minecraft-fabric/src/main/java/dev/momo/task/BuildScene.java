package dev.momo.task;
import com.google.gson.*;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.Registries;
import net.minecraft.item.Items;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;
/** Game-thread scene adapter. New targets are read only after an actual sight ray. */
final class BuildScene implements BuildTask.Scene {
 private final MinecraftClient c=MinecraftClient.getInstance();private final SparseBuild plan;
 private net.minecraft.client.world.ClientWorld world;private Vec3d origin;private String owner;
 private final Map<String,Integer> before=new LinkedHashMap<>();
 private BuildScene(SparseBuild plan){this.plan=plan;}
 static TaskRuntime.Work create(JsonObject args){var plan=SparseBuild.from(args);return new BuildTask(plan.cells(),new BuildScene(plan));}
 private BlockPos pos(SparseBuild.Cell cell){return new BlockPos(cell.x(),cell.y(),cell.z());}
 public void start(){
  if(c.player==null||c.world==null)throw new TaskRuntime.Rejected("world_unavailable");
  if(c.currentScreen!=null)throw new TaskRuntime.Rejected("close_station_first");
  if(origin==null){world=c.world;origin=c.player.getPos();owner=c.player.getUuidAsString();}
  check();
  for(var cell:plan.cells()){
   if(!world.isChunkLoaded(pos(cell))||pos(cell).getSquaredDistance(origin)>1024)throw new TaskRuntime.Rejected("outside_known_terrain");
   var id=Identifier.of(cell.block());if(!Registries.BLOCK.containsId(id))throw new TaskRuntime.Rejected("block_unknown");
   var item=Registries.BLOCK.get(id).asItem();if(item==Items.AIR)throw new TaskRuntime.Rejected("block_not_placeable");
   String key=Registries.ITEM.getId(item).toString();before.computeIfAbsent(key,this::count);
  }
 }
 private int count(String item){int count=0;for(int i=0;i<c.player.getInventory().size();i++){var stack=c.player.getInventory().getStack(i);if(Registries.ITEM.getId(stack.getItem()).toString().equals(item))count+=stack.getCount();}return count;}
 public List<Map<String,Object>> materials(){var result=new ArrayList<Map<String,Object>>();if(c.player!=null&&c.world==world&&owner!=null&&owner.equals(c.player.getUuidAsString()))before.forEach((item,amount)->result.add(Map.of("item",item,"countBefore",amount,"countAfter",count(item))));return List.copyOf(result);}
 public void check(){
  if(c.world!=world||c.player==null||!c.player.isAlive()||!c.player.getUuidAsString().equals(owner))throw new TaskRuntime.Rejected("world_unavailable");
  if(c.player.squaredDistanceTo(origin)>1024)throw new TaskRuntime.Rejected("outside_known_terrain");
 }
 public List<SparseBuild.Cell> visible(List<SparseBuild.Cell> pending){
  var result=new ArrayList<SparseBuild.Cell>();
  for(var cell:pending){var pos=pos(cell);
   if(!world.isChunkLoaded(pos)||pos.getSquaredDistance(c.player.getPos())>1024)continue;
   var hit=world.raycast(new RaycastContext(c.player.getEyePos(),pos.toCenterPos(),RaycastContext.ShapeType.COLLIDER,RaycastContext.FluidHandling.ANY,c.player));
   boolean seen=hit.getType()==HitResult.Type.MISS||hit instanceof net.minecraft.util.hit.BlockHitResult block&&block.getBlockPos().equals(pos);
   if(!seen)for(var face:Direction.values()){
    var point=pos.toCenterPos().add(face.getOffsetX()*.499,face.getOffsetY()*.499,face.getOffsetZ()*.499);
    var sample=world.raycast(new RaycastContext(c.player.getEyePos(),point,RaycastContext.ShapeType.COLLIDER,RaycastContext.FluidHandling.ANY,c.player));
    if(sample instanceof net.minecraft.util.hit.BlockHitResult block&&sample.getType()==HitResult.Type.BLOCK&&block.getBlockPos().equals(pos)){seen=true;break;}
   }
   if(seen)result.add(cell);
  }
  return result;
 }
 public boolean matches(SparseBuild.Cell known){return world.isChunkLoaded(pos(known))&&world.getBlockState(pos(known)).isOf(Registries.BLOCK.get(Identifier.of(known.block())));}
 public TaskRuntime.Work build(List<SparseBuild.Cell> visible){
  var args=new JsonObject();var cells=new JsonArray();for(var cell:visible){var value=new JsonObject();value.addProperty("x",cell.x());value.addProperty("y",cell.y());value.addProperty("z",cell.z());value.addProperty("block",cell.block());cells.add(value);}args.add("cells",cells);return new BuilderSkill(args);
 }
 public TaskRuntime.Work approach(int attempt){
  int midX=plan.x()+(plan.width()-1)/2,midZ=plan.z()+(plan.length()-1)/2;
  int x=switch(attempt){case 1->plan.x()-2;case 2->plan.x()+plan.width()+1;default->midX;};
  int z=switch(attempt){case 3->plan.z()-2;case 4->plan.z()+plan.length()+1;default->midZ;};
  if(Math.abs((long)x)>30000000||Math.abs((long)z)>30000000||Math.pow(x+.5-origin.x,2)+Math.pow(z+.5-origin.z,2)>1024||!world.isChunkLoaded(BlockPos.ofFloored(x,c.player.getY(),z)))return null;
  var args=new JsonObject();args.addProperty("x",x);args.addProperty("z",z);args.addProperty("height","surface");args.addProperty("terrain","preserve");return GameSkills.create("navigate",args);
 }
}
