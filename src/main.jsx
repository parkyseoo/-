import React from 'react'
import ReactDOM from 'react-dom/client'
import SmartPlateApp from './SmartPlateApp.jsx' // App.jsx 대신 SmartPlateApp을 연결!
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SmartPlateApp />
  </React.StrictMode>,
)
