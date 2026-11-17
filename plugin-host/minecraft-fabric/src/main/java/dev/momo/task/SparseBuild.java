package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.*;
/** A small immutable declarative blueprint. Unspecified cells are never included. */
public final class SparseBuild {
 public record Cell(int x,int y,int z,String block){
  public Cell{if(x< -30000000||x>30000000||z< -30000000||z>30000000||y< -64||y>319||block==null||block.isBlank()||block.length()>128)throw new IllegalArgumentException("Invalid build cell");}
  public boolean clearance(){return block.equals("minecraft:air");}
  public boolean matchesState(String state){return state!=null&&(state.startsWith("Block{"+block+"}")||clearance()&&(state.startsWith("Block{minecraft:cave_air}")||state.startsWith("Block{minecraft:void_air}")));}
 }
 private record Position(int x,int y,int z){}
 private final List<Cell> cells;private final Map<Position,Cell> positions=new HashMap<>();private final int x,y,z,width,height,length;
 public SparseBuild(List<Cell> cells){
  if(cells.isEmpty()||cells.size()>32)throw new IllegalArgumentException("Invalid build size");this.cells=List.copyOf(cells);
  x=cells.stream().mapToInt(Cell::x).min().orElseThrow();y=cells.stream().mapToInt(Cell::y).min().orElseThrow();z=cells.stream().mapToInt(Cell::z).min().orElseThrow();
  width=cells.stream().mapToInt(Cell::x).max().orElseThrow()-x+1;height=cells.stream().mapToInt(Cell::y).max().orElseThrow()-y+1;length=cells.stream().mapToInt(Cell::z).max().orElseThrow()-z+1;
  if(width>16||height>16||length>16)throw new IllegalArgumentException("Invalid build extent");
  for(var cell:cells)if(positions.putIfAbsent(new Position(cell.x(),cell.y(),cell.z()),cell)!=null)throw new IllegalArgumentException("Invalid duplicate build cell");
 }
 public static SparseBuild from(JsonObject args){
  if(args.has("cells")==args.has("box"))throw new IllegalArgumentException("Choose cells or box");
  var cells=new ArrayList<Cell>();
  if(args.has("cells"))for(var value:args.getAsJsonArray("cells")){var c=value.getAsJsonObject();cells.add(new Cell(c.get("x").getAsInt(),c.get("y").getAsInt(),c.get("z").getAsInt(),c.get("block").getAsString()));}
  else{
   var b=args.getAsJsonObject("box");int x=b.get("x").getAsInt(),y=b.get("y").getAsInt(),z=b.get("z").getAsInt(),w=b.get("width").getAsInt(),h=b.get("height").getAsInt(),l=b.get("length").getAsInt();
   String block=b.get("block").getAsString(),mode=b.has("mode")?b.get("mode").getAsString():"solid";
   if(w<1||w>16||h<1||h>16||l<1||l>16||!Set.of("solid","walls").contains(mode))throw new IllegalArgumentException("Invalid box");
   if((mode.equals("walls")?w*l-Math.max(0,w-2)*Math.max(0,l-2):w*l)*h>32)throw new IllegalArgumentException("Invalid build size");
   for(int dx=0;dx<w;dx++)for(int dy=0;dy<h;dy++)for(int dz=0;dz<l;dz++){
    if(mode.equals("walls")&&dx>0&&dx<w-1&&dz>0&&dz<l-1)continue;
    cells.add(new Cell(x+dx,y+dy,z+dz,block));
   }
  }
  return new SparseBuild(cells);
 }
 public List<Cell> cells(){return cells;}public int x(){return x;}public int y(){return y;}public int z(){return z;}public int width(){return width;}public int height(){return height;}public int length(){return length;}
 public Cell local(int x,int y,int z){return x<0||x>=width||y<0||y>=height||z<0||z>=length?null:positions.get(new Position(this.x+x,this.y+y,this.z+z));}
}
