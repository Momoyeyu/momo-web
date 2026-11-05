package dev.momo;
public final class BoundedPathSmoke {
 public static void main(String[] args) {
  var start=new BoundedPath.Cell(0,0);var goal=new BoundedPath.Cell(8,0);
  var path=BoundedPath.find(start,goal,c->!(c.x()==3&&c.z()>=-2&&c.z()<=2),512);
  if(path.isEmpty() || path.stream().anyMatch(c->c.x()==3&&Math.abs(c.z())<=2)) throw new AssertionError("wall traversal");
  if(path.stream().noneMatch(c->Math.abs(c.z())>2))throw new AssertionError("missing detour");
  if(!BoundedPath.find(start,goal,c->false,512).isEmpty())throw new AssertionError("blocked");
  if(!BoundedPath.find(start,goal,c->true,1).isEmpty())throw new AssertionError("budget ignored");
  if(!BoundedPath.find(start,start,c->true,512).isEmpty())throw new AssertionError("already arrived");
  System.out.println("Bounded path smoke: detour, blocked, budget, arrived passed");
 }
}
