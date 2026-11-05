package dev.momo;

import java.util.*;
import java.util.function.Predicate;

/** Deterministic bounded ground navigation. Never digs, jumps or explores unloaded terrain. */
public final class BoundedPath {
 public record Cell(int x, int z) {}
 public static List<Cell> find(Cell start, Cell goal, Predicate<Cell> safe, int budget) {
  var queue = new ArrayDeque<Cell>();
  var parent = new HashMap<Cell, Cell>();
  queue.add(start); parent.put(start, start);
  Cell found = null;
  while (!queue.isEmpty() && budget-- > 0) {
   Cell c = queue.remove();
   if (Math.abs(c.x-goal.x)+Math.abs(c.z-goal.z)<=2) { found=c;break; }
   for (int[] step : new int[][]{{1,0},{0,1},{-1,0},{0,-1}}) {
    Cell next = new Cell(c.x+step[0],c.z+step[1]);
    if (Math.abs(next.x-start.x)>16 || Math.abs(next.z-start.z)>16 || parent.containsKey(next) || !safe.test(next)) continue;
    parent.put(next,c);queue.add(next);
   }
  }
  if (found==null) return List.of();
  var path = new ArrayList<Cell>();
  while (!found.equals(start)) { path.add(found);found=parent.get(found); }
  Collections.reverse(path);return path;
 }
}
