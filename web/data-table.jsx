import React from 'react';

// Keep column headers and table navigation while displaying labeled records
// on narrow screens. Every action and value remains in the same DOM.
export function DataTable({headers,caption,children}){
 return <div className="table-wrap"><table className="mobile-table" role="table">
  {caption&&<caption>{caption}</caption>}
  <thead role="rowgroup"><tr role="row">{headers.map(header=><th scope="col" role="columnheader" key={header}>{header}</th>)}</tr></thead>
  <tbody role="rowgroup">{React.Children.map(children,row=>React.cloneElement(row,{role:'row'},React.Children.map(row.props.children,(cell,index)=>React.cloneElement(cell,{'data-label':headers[index],role:'cell'}))))}</tbody>
 </table></div>;
}
