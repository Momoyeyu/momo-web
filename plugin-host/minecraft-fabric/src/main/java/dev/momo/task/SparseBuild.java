package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.*;
/** A small immutable declarative blueprint. Unspecified cells are never included. */
public final class SparseBuild {
 public record Cell(int x,int y,int z,String block){public Cell{if(x< -30000000||x>30000000||z< -30000000||z>30000000||y< -64||y>319||block==null||block.isBlank()||block.length()>128)throw new IllegalArgumentException("Invalid build cell");}}
 private record Position(int x,int y,int z){}
 private final List<Cell> cells;private final Map<Position,Cell> positions=new HashMap<>();private final int x,y,z,width,height,length;
 public SparseBuild(List<Cell> cells){
  if(cells.isEmpty()||cells.size()>32)throw new IllegalArgumentException("Invalid build size");this.cells=List.copyOf(cells);
  x=cells.stream().mapToInt(Cell::x).min().orElseThrow();y=cells.stream().mapToInt(Cell::y).min().orElseThrow();z=cells.stream().mapToInt(Cell::z).min().orElseThrow();
  width=cells.stream().mapToInt(Cell::x).max().orElseThrow()-x+1;height=cells.stream().mapToInt(Cell::y).max().orElseThrow()-y+1;length=cells.stream().mapToInt(Cell::z).max().orElseThrow()-z+1;
  if(width>16||height>16||length>16)throw new IllegalArgumentException("Invalid build extent");
  for(var cell:cells)if(positions.putIfAbsent(new Position(cell.x(),cell.y(),cell.z()),cell)!=null)throw new IllegalArgumentException("Invalid duplicate build cell");
 }
 public static SparseBuild from(JsonObject args){var cells=new ArrayList<Cell>();for(var value:args.getAsJsonArray("cells")){var c=value.getAsJsonObject();cells.add(new Cell(c.get("x").getAsInt(),c.get("y").getAsInt(),c.get("z").getAsInt(),c.get("block").getAsString()));}return new SparseBuild(cells);}
 public List<Cell> cells(){return cells;}public int x(){return x;}public int y(){return y;}public int z(){return z;}public int width(){return width;}public int height(){return height;}public int length(){return length;}
 public Cell local(int x,int y,int z){return x<0||x>=width||y<0||y>=height||z<0||z>=length?null:positions.get(new Position(this.x+x,this.y+y,this.z+z));}
}
