import React from "react";
import Hero from "./components/Hero";
import WhatIs from "./components/WhatIs";
import Features from "./components/Features";
import SystemRequirements from "./components/SystemRequirements";
import Installation from "./components/Installation";
import VersionInfo from "./components/VersionInfo";
import Footer from "./components/Footer";

function App() {
  return (
    <>
      <Hero />
      <div className="main-content bg-black">
        <div className="container">
          <WhatIs />
          <Features />
          <SystemRequirements />
          <Installation />
          <VersionInfo />
        </div>
      </div>
      <Footer />
    </>
  );
}

export default App;
