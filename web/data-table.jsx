import React from 'react';

// Keep column headers and table navigation while displaying labeled records
// on narrow screens. Every action and value remains in the same DOM.
// columns: optional fixed widths (CSS lengths, null for the flexible column) which opts into the 2.3.0
// fixed-layout table; numeric: header indexes right-aligned as tabular numbers. Phones stack rows.
export function DataTable({headers,caption,children,columns,numeric=[]}){
 const fixed=Array.isArray(columns),num=index=>numeric.includes(index)?'num':undefined;
 return <div className={fixed?'table-wrap data-table-wrap':'table-wrap'}><table className={fixed?'data-table mobile-table':'mobile-table'} role="table">
  {caption&&<caption>{caption}</caption>}
  {fixed&&<colgroup>{columns.map((width,index)=><col key={index} style={width?{width}:undefined}/>)}</colgroup>}
  <thead role="rowgroup"><tr role="row">{headers.map((header,index)=><th scope="col" role="columnheader" className={num(index)} key={header}>{header}</th>)}</tr></thead>
  <tbody role="rowgroup">{React.Children.map(children,row=>React.cloneElement(row,{role:'row'},React.Children.map(row.props.children,(cell,index)=>React.cloneElement(cell,{'data-label':headers[index],role:'cell',className:[cell.props.className,num(index)].filter(Boolean).join(' ')||undefined}))))}</tbody>
 </table></div>;
}
