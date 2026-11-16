package dev.momo.task;
import java.util.*;
import net.minecraft.util.math.*;
/** Actual body volume, headroom and shallow landing geometry, without a model. */
final class EscapeRouteSmoke {
 private static final Box BODY=new Box(.2,0,.2,.8,1.8,.8);
 private static final Box FLOOR=new Box(-8,-1,-8,8,0,8);
 private static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 private static final class Scene implements EscapeRoute.Scene {
  final List<Box> blocks;boolean loaded=true,hazard;int reads;
  Scene(List<Box> blocks){this.blocks=blocks;}
  public boolean known(Box area){return loaded;}
  public List<Box> collisions(Box area){reads++;return blocks.stream().filter(area::intersects).toList();}
  public boolean dangerous(Box area){return hazard;}
 }
 private static List<Box> ring(double height){
  var blocks=new ArrayList<Box>();blocks.add(FLOOR);
  for(int i=0;i<8;i++){
   double a=Math.toRadians(i*45);int x=(int)Math.floor(.5-Math.sin(a)*2),z=(int)Math.floor(.5+Math.cos(a)*2);
   blocks.add(new Box(x,0,z,x+1,height,z+1));
  }
  return blocks;
 }
 public static void main(String[] args){
  var flat=EscapeRoute.choose(BODY,0,0,false,new Scene(List.of(FLOOR)),p->-p.x).orElseThrow();
  check(flat.landing().x<0&&!flat.jump()&&flat.landing().y==0,"flat retreat runs toward a real safe landing");
  var step=EscapeRoute.choose(BODY,0,0,false,new Scene(ring(1)),p->-p.x).orElseThrow();
  check(step.jump()&&step.landing().y==1,"one-block terrain must be escaped by a real forward jump, not excluded as occupied feet");
  var half=EscapeRoute.choose(BODY,0,0,false,new Scene(ring(.5)),p->-p.x).orElseThrow();
  check(half.jump()&&half.landing().y==.5,"use actual collision top heights, including slabs");
  check(EscapeRoute.choose(BODY,0,0,false,new Scene(ring(2)),p->-p.x).isEmpty(),"two-block walls are not jumpable landings");
  var ceiling=ring(1);ceiling.add(new Box(-4,2,-4,4,3,4));
  check(EscapeRoute.choose(BODY,0,0,false,new Scene(ceiling),p->-p.x).isEmpty(),"a clear foot cell cannot authorize jumping into a low ceiling");
  var headBlocks=new ArrayList<Box>();headBlocks.add(FLOOR);
  for(var block:ring(1).subList(1,9))headBlocks.add(block.offset(0,1,0).stretch(0,1,0));
  check(EscapeRoute.choose(BODY,0,0,false,new Scene(headBlocks),p->-p.x).isEmpty(),"test head and shoulder volume rather than just the destination feet block");
  var down=new Scene(List.of(new Box(-8,-2,-8,8,-1,8),new Box(0,-1,0,1,0,1)));
  var drop=EscapeRoute.choose(BODY,0,0,false,down,p->-p.x).orElseThrow();
  check(drop.landing().y==-1&&!drop.jump(),"one-block descent is ordinary safe retreat");
  check(EscapeRoute.choose(BODY,0,0,false,new Scene(List.of(new Box(-8,-3,-8,8,-2,8))),p->-p.x).isEmpty(),"do not choose an unsupported cliff as a shortcut");
  var missing=new Scene(List.of(FLOOR));missing.loaded=false;
  check(EscapeRoute.choose(BODY,0,0,false,missing,p->-p.x).isEmpty()&&missing.reads==0,"unloaded local collision space must not be queried");
  var hot=new Scene(List.of(FLOOR));hot.hazard=true;
  check(EscapeRoute.choose(BODY,0,0,false,hot,p->-p.x).isEmpty(),"a hazardous volume is never a valid escape destination");
  var airborne=EscapeRoute.choose(BODY.offset(0,1.2,0),0,0,false,new Scene(List.of(FLOOR)),p->-p.x).orElseThrow();
  check(airborne.landing().y==0,"a normal jump retains its last ground reference instead of losing every floor midair");
  check(EscapeRoute.choose(BODY,0,0,true,new Scene(List.of()),p->-p.x).isPresent(),"swimming does not require a solid floor under the player");
  check(EscapeRoute.choose(BODY,0,0,false,new Scene(List.of(FLOOR)),p->Double.NaN).isEmpty(),"an invalid score cannot authorize movement");
  System.out.println("PASS bounded escape landings, jump volume, slabs, shallow descent and no cliff/hazard guesses");
 }
}
