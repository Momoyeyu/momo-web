package dev.momo.task;
import java.util.*;
/** Filter the current menu's own choices, retaining its original button IDs. */
public final class StationOptions {
 public static List<Integer> matching(List<String> names,String query,int limit){
  if(limit<1||limit>16)throw new IllegalArgumentException("Invalid station query limit");
  String needle=query.toLowerCase(Locale.ROOT);var result=new ArrayList<Integer>();
  for(int i=0;i<names.size()&&result.size()<limit;i++)if(names.get(i).toLowerCase(Locale.ROOT).contains(needle))result.add(i);
  return List.copyOf(result);
 }
}
