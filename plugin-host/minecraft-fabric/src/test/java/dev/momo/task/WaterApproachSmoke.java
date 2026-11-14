package dev.momo.task;
public final class WaterApproachSmoke {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  check(WaterApproach.surfaceRoute(true,true),"Distant visible water targets need a surface route before a short dive");
  check(!WaterApproach.surfaceRoute(false,true)&&!WaterApproach.surfaceRoute(true,false),"Land-water transitions retain ordinary collision navigation");
  var below=WaterApproach.swim(true,true,true,1,-3,1);
  check(below.steer()&&below.forward()&&below.down()&&!below.up(),"A visible nearby underwater drop needs diving, not a surface walking goal");
  var above=WaterApproach.swim(true,true,true,0,2,0);
  check(above.steer()&&!above.forward()&&above.up()&&!above.down(),"Float upward without unnecessary horizontal movement");
  check(!WaterApproach.swim(false,true,true,1,-3,1).steer(),"Land approaches remain with the navigator");
  check(!WaterApproach.swim(true,true,false,1,-3,1).steer(),"Do not dive after an unseen target");
  check(!WaterApproach.swim(true,true,true,9,0,0).steer(),"Local swimming cannot replace long-range collision navigation");
  check(!WaterApproach.swim(true,true,true,Double.NaN,0,0).steer(),"Invalid coordinates never press inputs");
  var near=WaterApproach.swim(true,true,true,.1,.1,.1);
  check(near.steer()&&!near.forward()&&!near.up()&&!near.down(),"Wait for the actual pickup receipt at contact instead of overshooting");
  System.out.println("PASS bounded visible underwater pickup steering");
 }
}
